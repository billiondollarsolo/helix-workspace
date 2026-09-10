import type { JsonObject } from "@helix/sdk";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { SCIM_BODY_LIMIT_BYTES } from "../../api/request-body.js";
import type { OrgStore } from "../tenancy/orgs.js";
import { ipMatchesAllowlist } from "./credentials.js";
import {
  scimCredentialIdFromToken,
  verifyScimBearerToken,
  type ScimCredentialScope,
  type TenantScimCredentialStore,
} from "./scim-credentials.js";
import {
  ScimConflictError,
  ScimPreconditionError,
  type PutScimGroup,
  type PutScimUser,
  type ScimFilter,
  type ScimGroupRecord,
  type ScimProvisioningStore,
  type ScimUserRecord,
} from "./scim-provisioning.js";

/**
 * Audit sink consumed when a SCIM request fails authentication. Matches the
 * shape of `PostgresAuditStore.append` used elsewhere in the platform. The
 * sink is best-effort: audit failures must never leak through as a 500 to the
 * caller because that would re-introduce an enumeration oracle.
 */
export interface ScimAuthAuditSink {
  append(record: {
    readonly orgId: string;
    readonly actorId: string | null;
    readonly verb: string;
    readonly objectType: string;
    readonly objectId?: string;
    readonly metadata?: JsonObject;
  }): Promise<unknown>;
}

interface ScimAuthMetrics {
  recordScimAuthFailure(input: { readonly reason: ScimAuthFailureReason }): void;
}

export interface RegisterTenantScimRoutesOptions {
  readonly orgs: Pick<OrgStore, "findBySlug">;
  /**
   * Per-tenant SCIM bearer token store. When omitted, every SCIM request is
   * rejected with 401 - SCIM is opt-in per tenant and the absence of a store
   * means no tenant can provision tokens. (We still register the routes so
   * the surface returns a consistent SCIM error envelope.)
   */
  readonly credentials?: Pick<TenantScimCredentialStore, "findById" | "markUsed"> | undefined;
  readonly provisioning: ScimProvisioningStore;
  readonly auditSink?: ScimAuthAuditSink | undefined;
  readonly metrics?: ScimAuthMetrics | undefined;
  readonly documentationUri?: string | undefined;
}

const scimTenantParams = z.object({
  tenantSlug: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
});

const SCIM_JSON = "application/scim+json; charset=utf-8";
const LIST_RESPONSE_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const SCIM_BASE_PREFIX = "/api/scim/v2/:tenantSlug";
const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const USER_EXTENSION = "urn:helix:params:scim:schemas:extension:2.0:User";
const INVALID_SCIM_JSON = Object.freeze({ invalidScimJson: true });
const resourceParams = scimTenantParams.extend({ resourceId: z.string().uuid() });
const listQuery = z.object({
  startIndex: z.coerce.number().int().min(1).default(1),
  count: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(100),
  filter: z.string().trim().min(1).max(500).optional(),
});
const userBody = z
  .object({
    schemas: z.array(z.string()).optional(),
    externalId: z.string().trim().min(1).max(255).nullable().optional(),
    userName: z.string().trim().email().max(320),
    displayName: z.string().trim().min(1).max(200).optional(),
    active: z.boolean().default(true),
    name: z
      .object({
        formatted: z.string().trim().min(1).max(200).optional(),
        givenName: z.string().trim().min(1).max(100).nullable().optional(),
        familyName: z.string().trim().min(1).max(100).nullable().optional(),
      })
      .passthrough()
      .optional(),
    emails: z
      .array(
        z
          .object({ value: z.string().trim().email().max(320), primary: z.boolean().optional() })
          .passthrough(),
      )
      .max(20)
      .optional(),
    [USER_EXTENSION]: z
      .object({ dataTransferTargetId: z.string().uuid().nullable().optional() })
      .optional(),
  })
  .passthrough();
const groupBody = z
  .object({
    schemas: z.array(z.string()).optional(),
    externalId: z.string().trim().min(1).max(255).nullable().optional(),
    displayName: z.string().trim().min(1).max(200),
    members: z
      .array(z.object({ value: z.string().uuid() }).passthrough())
      .max(10_000)
      .default([]),
  })
  .passthrough();
const patchBody = z
  .object({
    schemas: z.array(z.string()).refine((schemas) => schemas.includes(PATCH_SCHEMA)),
    Operations: z
      .array(
        z.object({
          op: z
            .string()
            .transform((op) => op.toLowerCase())
            .pipe(z.enum(["add", "remove", "replace"])),
          path: z.string().trim().min(1).max(500).optional(),
          value: z.unknown().optional(),
        }),
      )
      .min(1)
      .max(100),
  })
  .passthrough();

/**
 * Register the per-tenant SCIM v2 endpoints. Every endpoint enforces a
 * per-tenant bearer token before any tenant lookup so the surface cannot be
 * used as an enumeration oracle. Users and Groups share the platform's
 * durable actor/group model, including optimistic concurrency and tenant
 * boundaries.
 */
export async function registerTenantScimRoutes(
  app: FastifyInstance,
  options: RegisterTenantScimRoutesOptions,
): Promise<void> {
  app.addContentTypeParser(
    "application/scim+json",
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        const json = typeof body === "string" ? body : body.toString("utf8");
        done(null, json.length === 0 ? null : (JSON.parse(json) as unknown));
      } catch {
        // Let the route schema return a SCIM Error response instead of Fastify's
        // generic JSON parser envelope.
        done(null, INVALID_SCIM_JSON);
      }
    },
  );
  app.get(`${SCIM_BASE_PREFIX}/ServiceProviderConfig`, async (request, reply) => {
    const auth = await authenticateScimRequest(request, reply, options);
    if (!auth.ok) {
      return reply;
    }
    return reply
      .code(200)
      .header("content-type", SCIM_JSON)
      .header("cache-control", "no-store")
      .send(serviceProviderConfig(options.documentationUri));
  });

  app.get(`${SCIM_BASE_PREFIX}/ResourceTypes`, async (request, reply) => {
    const auth = await authenticateScimRequest(request, reply, options);
    if (!auth.ok) {
      return reply;
    }
    return reply
      .code(200)
      .header("content-type", SCIM_JSON)
      .header("cache-control", "no-store")
      .send(scimListResponse(resourceTypes(auth.slug)));
  });

  app.get(`${SCIM_BASE_PREFIX}/ResourceTypes/:discoveryId`, async (request, reply) => {
    const auth = await authenticateScimRequest(request, reply, options);
    if (!auth.ok) return reply;
    const id = discoveryId(request.params);
    const resource =
      id === null ? undefined : resourceTypes(auth.slug).find((entry) => entry.id === id);
    return resource === undefined
      ? sendScimError(reply, 404, "Resource type not found.")
      : sendScim(reply, 200, resource);
  });

  app.get(`${SCIM_BASE_PREFIX}/Schemas`, async (request, reply) => {
    const auth = await authenticateScimRequest(request, reply, options);
    if (!auth.ok) {
      return reply;
    }
    return reply
      .code(200)
      .header("content-type", SCIM_JSON)
      .header("cache-control", "no-store")
      .send(scimListResponse(scimSchemas()));
  });

  app.get(`${SCIM_BASE_PREFIX}/Schemas/:discoveryId`, async (request, reply) => {
    const auth = await authenticateScimRequest(request, reply, options);
    if (!auth.ok) return reply;
    const id = discoveryId(request.params);
    const schema = id === null ? undefined : scimSchemas().find((entry) => entry.id === id);
    return schema === undefined
      ? sendScimError(reply, 404, "Schema not found.")
      : sendScim(reply, 200, schema);
  });

  registerUserRoutes(app, options);
  registerGroupRoutes(app, options);
}

function registerUserRoutes(app: FastifyInstance, options: RegisterTenantScimRoutesOptions): void {
  app.get(`${SCIM_BASE_PREFIX}/Users`, async (request, reply) => {
    const auth = await authenticateScimRequest(request, reply, options);
    if (!auth.ok) return reply;
    const query = listQuery.safeParse(request.query);
    if (!query.success)
      return sendScimError(reply, 400, "Invalid pagination parameters.", "invalidValue");
    const filter = parseFilter(query.data.filter, ["id", "externalId", "userName"]);
    if (filter instanceof Error) return sendScimError(reply, 400, filter.message, "invalidFilter");
    const page = await options.provisioning.listUsers(
      auth.orgId,
      filter,
      query.data.startIndex - 1,
      Math.max(1, Math.min(200, query.data.count)),
    );
    return sendScim(reply, 200, {
      schemas: [LIST_RESPONSE_SCHEMA],
      totalResults: page.total,
      startIndex: query.data.startIndex,
      itemsPerPage: query.data.count === 0 ? 0 : page.resources.length,
      Resources:
        query.data.count === 0 ? [] : page.resources.map((user) => userResource(user, auth.slug)),
    });
  });

  app.post(
    `${SCIM_BASE_PREFIX}/Users`,
    { bodyLimit: SCIM_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const auth = await authenticateScimRequest(request, reply, options);
      if (!auth.ok) return reply;
      const parsed = userBody.safeParse(request.body);
      if (!parsed.success) return invalidBody(reply, parsed.error.message);
      try {
        const result = await options.provisioning.createUser(auth.orgId, toPutUser(parsed.data));
        return await sendResource(
          reply,
          result.created ? 201 : 200,
          userResource(result.record, auth.slug),
        );
      } catch (error) {
        return handleWriteError(reply, error);
      }
    },
  );

  app.get(`${SCIM_BASE_PREFIX}/Users/:resourceId`, async (request, reply) => {
    const auth = await authenticateScimRequest(request, reply, options);
    if (!auth.ok) return reply;
    const params = resourceParams.safeParse(request.params);
    if (!params.success) return sendScimError(reply, 404, "User not found.");
    const user = await options.provisioning.getUser(auth.orgId, params.data.resourceId);
    return user === null
      ? sendScimError(reply, 404, "User not found.")
      : sendResource(reply, 200, userResource(user, auth.slug));
  });

  app.put(
    `${SCIM_BASE_PREFIX}/Users/:resourceId`,
    { bodyLimit: SCIM_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const auth = await authenticateScimRequest(request, reply, options);
      if (!auth.ok) return reply;
      const params = resourceParams.safeParse(request.params);
      const parsed = userBody.safeParse(request.body);
      if (!params.success) return sendScimError(reply, 404, "User not found.");
      if (!parsed.success) return invalidBody(reply, parsed.error.message);
      const expected = parseIfMatch(request.headers["if-match"]);
      if (expected instanceof Error) return invalidBody(reply, expected.message);
      try {
        const user = await options.provisioning.putUser(
          auth.orgId,
          params.data.resourceId,
          toPutUser(parsed.data),
          expected,
        );
        return user === null
          ? await sendScimError(reply, 404, "User not found.")
          : await sendResource(reply, 200, userResource(user, auth.slug));
      } catch (error) {
        return handleWriteError(reply, error);
      }
    },
  );

  app.patch(
    `${SCIM_BASE_PREFIX}/Users/:resourceId`,
    { bodyLimit: SCIM_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const auth = await authenticateScimRequest(request, reply, options);
      if (!auth.ok) return reply;
      const params = resourceParams.safeParse(request.params);
      const parsed = patchBody.safeParse(request.body);
      if (!params.success) return sendScimError(reply, 404, "User not found.");
      if (!parsed.success) return invalidBody(reply, parsed.error.message);
      const expected = parseIfMatch(request.headers["if-match"]);
      if (expected instanceof Error) return invalidBody(reply, expected.message);
      const current = await options.provisioning.getUser(auth.orgId, params.data.resourceId);
      if (current === null) return sendScimError(reply, 404, "User not found.");
      let input: PutScimUser;
      try {
        input = applyUserPatch(current, parsed.data.Operations);
      } catch (error) {
        return invalidBody(
          reply,
          error instanceof Error ? error.message : "Invalid PATCH operation.",
        );
      }
      try {
        const user = await options.provisioning.putUser(
          auth.orgId,
          params.data.resourceId,
          input,
          expected,
        );
        return user === null
          ? await sendScimError(reply, 404, "User not found.")
          : await sendResource(reply, 200, userResource(user, auth.slug));
      } catch (error) {
        return handleWriteError(reply, error);
      }
    },
  );

  app.delete(`${SCIM_BASE_PREFIX}/Users/:resourceId`, async (request, reply) => {
    const auth = await authenticateScimRequest(request, reply, options);
    if (!auth.ok) return reply;
    const params = resourceParams.safeParse(request.params);
    if (!params.success) return sendScimError(reply, 404, "User not found.");
    const expected = parseIfMatch(request.headers["if-match"]);
    if (expected instanceof Error) return invalidBody(reply, expected.message);
    const transfer = parseTransferHeader(request.headers["x-helix-transfer-to"]);
    if (transfer instanceof Error) return invalidBody(reply, transfer.message);
    let deleted: boolean;
    try {
      deleted = await options.provisioning.deleteUser(
        auth.orgId,
        params.data.resourceId,
        expected,
        transfer,
      );
    } catch (error) {
      return handleWriteError(reply, error);
    }
    return deleted ? reply.code(204).send() : sendScimError(reply, 404, "User not found.");
  });
}

function registerGroupRoutes(app: FastifyInstance, options: RegisterTenantScimRoutesOptions): void {
  app.get(`${SCIM_BASE_PREFIX}/Groups`, async (request, reply) => {
    const auth = await authenticateScimRequest(request, reply, options);
    if (!auth.ok) return reply;
    const query = listQuery.safeParse(request.query);
    if (!query.success)
      return sendScimError(reply, 400, "Invalid pagination parameters.", "invalidValue");
    const filter = parseFilter(query.data.filter, ["id", "externalId", "displayName"]);
    if (filter instanceof Error) return sendScimError(reply, 400, filter.message, "invalidFilter");
    const page = await options.provisioning.listGroups(
      auth.orgId,
      filter,
      query.data.startIndex - 1,
      Math.max(1, Math.min(200, query.data.count)),
    );
    return sendScim(reply, 200, {
      schemas: [LIST_RESPONSE_SCHEMA],
      totalResults: page.total,
      startIndex: query.data.startIndex,
      itemsPerPage: query.data.count === 0 ? 0 : page.resources.length,
      Resources:
        query.data.count === 0
          ? []
          : page.resources.map((group) => groupResource(group, auth.slug)),
    });
  });

  app.post(
    `${SCIM_BASE_PREFIX}/Groups`,
    { bodyLimit: SCIM_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const auth = await authenticateScimRequest(request, reply, options);
      if (!auth.ok) return reply;
      const parsed = groupBody.safeParse(request.body);
      if (!parsed.success) return invalidBody(reply, parsed.error.message);
      try {
        const result = await options.provisioning.createGroup(auth.orgId, toPutGroup(parsed.data));
        return await sendResource(
          reply,
          result.created ? 201 : 200,
          groupResource(result.record, auth.slug),
        );
      } catch (error) {
        return handleWriteError(reply, error);
      }
    },
  );

  app.get(`${SCIM_BASE_PREFIX}/Groups/:resourceId`, async (request, reply) => {
    const auth = await authenticateScimRequest(request, reply, options);
    if (!auth.ok) return reply;
    const params = resourceParams.safeParse(request.params);
    if (!params.success) return sendScimError(reply, 404, "Group not found.");
    const group = await options.provisioning.getGroup(auth.orgId, params.data.resourceId);
    return group === null
      ? sendScimError(reply, 404, "Group not found.")
      : sendResource(reply, 200, groupResource(group, auth.slug));
  });

  app.put(
    `${SCIM_BASE_PREFIX}/Groups/:resourceId`,
    { bodyLimit: SCIM_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const auth = await authenticateScimRequest(request, reply, options);
      if (!auth.ok) return reply;
      const params = resourceParams.safeParse(request.params);
      const parsed = groupBody.safeParse(request.body);
      if (!params.success) return sendScimError(reply, 404, "Group not found.");
      if (!parsed.success) return invalidBody(reply, parsed.error.message);
      const expected = parseIfMatch(request.headers["if-match"]);
      if (expected instanceof Error) return invalidBody(reply, expected.message);
      try {
        const group = await options.provisioning.putGroup(
          auth.orgId,
          params.data.resourceId,
          toPutGroup(parsed.data),
          expected,
        );
        return group === null
          ? await sendScimError(reply, 404, "Group not found.")
          : await sendResource(reply, 200, groupResource(group, auth.slug));
      } catch (error) {
        return handleWriteError(reply, error);
      }
    },
  );

  app.patch(
    `${SCIM_BASE_PREFIX}/Groups/:resourceId`,
    { bodyLimit: SCIM_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const auth = await authenticateScimRequest(request, reply, options);
      if (!auth.ok) return reply;
      const params = resourceParams.safeParse(request.params);
      const parsed = patchBody.safeParse(request.body);
      if (!params.success) return sendScimError(reply, 404, "Group not found.");
      if (!parsed.success) return invalidBody(reply, parsed.error.message);
      const expected = parseIfMatch(request.headers["if-match"]);
      if (expected instanceof Error) return invalidBody(reply, expected.message);
      const current = await options.provisioning.getGroup(auth.orgId, params.data.resourceId);
      if (current === null) return sendScimError(reply, 404, "Group not found.");
      let input: PutScimGroup;
      try {
        input = applyGroupPatch(current, parsed.data.Operations);
      } catch (error) {
        return invalidBody(
          reply,
          error instanceof Error ? error.message : "Invalid PATCH operation.",
        );
      }
      try {
        const group = await options.provisioning.putGroup(
          auth.orgId,
          params.data.resourceId,
          input,
          expected,
        );
        return group === null
          ? await sendScimError(reply, 404, "Group not found.")
          : await sendResource(reply, 200, groupResource(group, auth.slug));
      } catch (error) {
        return handleWriteError(reply, error);
      }
    },
  );

  app.delete(`${SCIM_BASE_PREFIX}/Groups/:resourceId`, async (request, reply) => {
    const auth = await authenticateScimRequest(request, reply, options);
    if (!auth.ok) return reply;
    const params = resourceParams.safeParse(request.params);
    if (!params.success) return sendScimError(reply, 404, "Group not found.");
    const expected = parseIfMatch(request.headers["if-match"]);
    if (expected instanceof Error) return invalidBody(reply, expected.message);
    let deleted: boolean;
    try {
      deleted = await options.provisioning.deleteGroup(
        auth.orgId,
        params.data.resourceId,
        expected,
      );
    } catch (error) {
      return handleWriteError(reply, error);
    }
    return deleted ? reply.code(204).send() : sendScimError(reply, 404, "Group not found.");
  });
}

interface ScimAuthSuccess {
  readonly ok: true;
  readonly orgId: string;
  readonly slug: string;
}

interface ScimAuthFailure {
  readonly ok: false;
}

export type ScimAuthFailureReason =
  | "missing_bearer"
  | "invalid_slug"
  | "credentials_unconfigured"
  | "tenant_not_found"
  | "tenant_not_active"
  | "invalid_bearer"
  | "credential_revoked"
  | "credential_expired"
  | "source_not_allowed"
  | "insufficient_scope"
  | "credential_changed";

/**
 * Authenticate a SCIM request. Returns `{ ok: true }` only when:
 *
 *  1. The `Authorization: Bearer <token>` header is well-formed.
 *  2. The tenant slug parses and resolves to an active tenant.
 *  3. The token selects a credential owned by that tenant.
 *  4. The presented token verifies against its Argon2 hash.
 *  5. Expiry, revocation, source policy, and route scope all allow the call.
 *
 * Every other path returns a uniform 401 with the same SCIM error envelope so
 * the surface cannot leak whether a tenant exists, whether SCIM is enabled,
 * or whether the token matched but the tenant is missing.
 */
async function authenticateScimRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: RegisterTenantScimRoutesOptions,
): Promise<ScimAuthSuccess | ScimAuthFailure> {
  const presentedToken = extractBearerToken(request.headers["authorization"]);
  if (presentedToken === null) {
    await recordScimAuthFailure(options, request, "missing_bearer", null);
    sendScimUnauthorized(reply);
    return { ok: false };
  }

  // Parse the tenant slug shape before any DB lookup. A malformed slug must
  // still produce a 401, not a 400 - a 400 vs 401 difference would itself be
  // an enumeration oracle for which slugs match the regex.
  const parsedParams = scimTenantParams.safeParse(request.params);
  if (!parsedParams.success) {
    await recordScimAuthFailure(options, request, "invalid_slug", null);
    sendScimUnauthorized(reply);
    return { ok: false };
  }
  const slug = parsedParams.data.tenantSlug;

  if (options.credentials === undefined) {
    await recordScimAuthFailure(options, request, "credentials_unconfigured", null);
    sendScimUnauthorized(reply);
    return { ok: false };
  }

  const org = await options.orgs.findBySlug(slug);
  if (org === null || org.status !== "active") {
    await recordScimAuthFailure(
      options,
      request,
      org === null ? "tenant_not_found" : "tenant_not_active",
      org?.id ?? null,
    );
    sendScimUnauthorized(reply);
    return { ok: false };
  }

  const credentialId = scimCredentialIdFromToken(presentedToken);
  const credential =
    credentialId === null ? null : await options.credentials.findById(org.id, credentialId);
  if (credential === null) {
    await recordScimAuthFailure(options, request, "invalid_bearer", org.id);
    sendScimUnauthorized(reply);
    return { ok: false };
  }

  const valid = await verifyScimBearerToken(presentedToken, credential.tokenHash);
  if (!valid) {
    await recordScimAuthFailure(options, request, "invalid_bearer", org.id);
    sendScimUnauthorized(reply);
    return { ok: false };
  }

  const now = new Date();
  if (credential.revokedAt !== null) {
    await recordScimAuthFailure(options, request, "credential_revoked", org.id);
    sendScimUnauthorized(reply);
    return { ok: false };
  }
  if (credential.expiresAt <= now) {
    await recordScimAuthFailure(options, request, "credential_expired", org.id);
    sendScimUnauthorized(reply);
    return { ok: false };
  }
  if (
    credential.sourceCidrs.length > 0 &&
    !ipMatchesAllowlist(request.ip, credential.sourceCidrs)
  ) {
    await recordScimAuthFailure(options, request, "source_not_allowed", org.id);
    sendScimUnauthorized(reply);
    return { ok: false };
  }
  const requiredScope = requiredScimScope(request);
  if (requiredScope !== null && !credential.scopes.includes(requiredScope)) {
    await recordScimAuthFailure(options, request, "insufficient_scope", org.id);
    sendScimForbidden(reply);
    return { ok: false };
  }
  if (!(await options.credentials.markUsed(org.id, credential.id, now, request.ip))) {
    await recordScimAuthFailure(options, request, "credential_changed", org.id);
    sendScimUnauthorized(reply);
    return { ok: false };
  }

  return { ok: true, orgId: org.id, slug: org.slug };
}

function requiredScimScope(request: FastifyRequest): ScimCredentialScope | null {
  const route = request.routeOptions.url ?? "";
  const access = request.method === "GET" ? "read" : "write";
  if (route.includes("/Users")) return `scim.users.${access}`;
  if (route.includes("/Groups")) return `scim.groups.${access}`;
  return null;
}

function extractBearerToken(header: unknown): string | null {
  if (typeof header !== "string") {
    return null;
  }
  const match = /^Bearer\s+(\S+)\s*$/u.exec(header);
  if (match === null) {
    return null;
  }
  const token = match[1];
  if (token === undefined || token.length === 0) {
    return null;
  }
  return token;
}

function sendScimUnauthorized(reply: FastifyReply): void {
  reply
    .code(401)
    .header("content-type", SCIM_JSON)
    .header("www-authenticate", 'Bearer realm="Helix SCIM"')
    .send(scimError(401, "SCIM authentication required."));
}

function sendScimForbidden(reply: FastifyReply): void {
  reply
    .code(403)
    .header("content-type", SCIM_JSON)
    .send(scimError(403, "The SCIM credential does not grant this operation."));
}

async function recordScimAuthFailure(
  options: Pick<RegisterTenantScimRoutesOptions, "auditSink" | "metrics">,
  request: FastifyRequest,
  reason: ScimAuthFailureReason,
  orgId: string | null,
): Promise<void> {
  options.metrics?.recordScimAuthFailure({ reason });
  if (options.auditSink === undefined) return;
  // Never log token bytes. Capture only the request shape: source IP, the
  // path family (so /Users vs /Groups is visible), the HTTP method, the
  // user-agent (already public), and a coarse failure reason.
  const sourceIp = request.ip;
  const userAgent = headerString(request.headers["user-agent"]);
  try {
    await options.auditSink.append({
      orgId: orgId ?? "00000000-0000-0000-0000-000000000000",
      // Authentication failed, so no tenant actor can be attributed.
      actorId: null,
      verb: "scim.auth.failed",
      objectType: "scim_endpoint",
      metadata: {
        method: request.method,
        path: request.routeOptions.url ?? null,
        reason,
        sourceIp,
        ...(userAgent === null ? {} : { userAgent }),
      },
    });
  } catch (error) {
    request.log.error({ error, reason }, "Failed to record SCIM authentication failure");
  }
}

function headerString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return null;
}

function parseFilter(
  raw: string | undefined,
  allowed: readonly ScimFilter["attribute"][],
): ScimFilter | null | Error {
  if (raw === undefined) return null;
  const match = /^(id|externalId|userName|displayName)\s+eq\s+("(?:[^"\\]|\\.)*")$/iu.exec(raw);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return new Error(
      'Only an equality filter such as `userName eq "user@example.com"` is supported.',
    );
  }
  const canonical = allowed.find(
    (attribute) => attribute.toLowerCase() === match[1]?.toLowerCase(),
  );
  if (canonical === undefined)
    return new Error(`Attribute ${match[1]} cannot filter this resource.`);
  try {
    const value: unknown = JSON.parse(match[2]);
    return typeof value === "string" && value.length > 0
      ? { attribute: canonical, value }
      : new Error("Filter values must be non-empty strings.");
  } catch {
    return new Error("The SCIM filter contains an invalid quoted string.");
  }
}

function discoveryId(params: unknown): string | null {
  const parsed = z.object({ discoveryId: z.string().trim().min(1).max(255) }).safeParse(params);
  return parsed.success ? parsed.data.discoveryId : null;
}

function parseIfMatch(value: unknown): number | null | Error {
  if (value === undefined) return null;
  if (typeof value !== "string") return new Error("If-Match must contain one SCIM ETag.");
  if (value === "*") return null;
  const match = /^(?:W\/)?"([1-9][0-9]*)"$/u.exec(value.trim());
  if (match?.[1] === undefined) return new Error("If-Match must be a valid SCIM ETag.");
  const version = Number(match[1]);
  return Number.isSafeInteger(version) ? version : new Error("If-Match version is too large.");
}

function parseTransferHeader(value: unknown): string | null | Error {
  if (value === undefined) return null;
  const parsed = z.string().uuid().safeParse(value);
  return parsed.success
    ? parsed.data
    : new Error("x-helix-transfer-to must identify a user in this tenant.");
}

function toPutUser(value: z.infer<typeof userBody>): PutScimUser {
  const primaryEmail = value.emails?.find((email) => email.primary === true) ?? value.emails?.[0];
  if (
    primaryEmail !== undefined &&
    primaryEmail.value.toLowerCase() !== value.userName.toLowerCase()
  ) {
    throw new ScimConflictError("The primary email must equal userName.");
  }
  return {
    externalId: value.externalId ?? null,
    userName: value.userName,
    displayName: value.displayName ?? value.name?.formatted ?? value.userName,
    givenName: value.name?.givenName ?? null,
    familyName: value.name?.familyName ?? null,
    active: value.active,
    ...(value[USER_EXTENSION]?.dataTransferTargetId === undefined
      ? {}
      : { dataTransferTargetId: value[USER_EXTENSION].dataTransferTargetId }),
  };
}

function toPutGroup(value: z.infer<typeof groupBody>): PutScimGroup {
  return {
    externalId: value.externalId ?? null,
    displayName: value.displayName,
    memberIds: value.members.map((member) => member.value),
  };
}

interface PatchOperation {
  readonly op: string;
  readonly path?: string | undefined;
  readonly value?: unknown;
}

function applyUserPatch(
  current: ScimUserRecord,
  operations: readonly PatchOperation[],
): PutScimUser {
  const draft: {
    externalId: string | null;
    userName: string;
    displayName: string;
    givenName: string | null;
    familyName: string | null;
    active: boolean;
    dataTransferTargetId?: string | null | undefined;
  } = {
    externalId: current.externalId,
    userName: current.userName,
    displayName: current.displayName,
    givenName: current.givenName,
    familyName: current.familyName,
    active: current.active,
    dataTransferTargetId: current.dataTransferTargetId,
  };
  for (const operation of operations) {
    if (operation.path === undefined) {
      if (operation.op === "remove") throw new Error("A remove operation requires a path.");
      applyUserObject(draft, objectValue(operation.value));
      continue;
    }
    const path = operation.path.toLowerCase();
    if (operation.op === "remove") {
      if (path === "externalid") draft.externalId = null;
      else if (path === "displayname") draft.displayName = draft.userName;
      else if (path === "name.givenname") draft.givenName = null;
      else if (path === "name.familyname") draft.familyName = null;
      else if (path === `${USER_EXTENSION.toLowerCase()}.datatransfertargetid`) {
        draft.dataTransferTargetId = null;
      } else {
        throw new Error(`Attribute ${operation.path} cannot be removed.`);
      }
      continue;
    }
    if (path === "username") draft.userName = requiredString(operation.value, "userName");
    else if (path === "displayname") {
      draft.displayName = requiredString(operation.value, "displayName");
    } else if (path === "externalid")
      draft.externalId = optionalString(operation.value, "externalId");
    else if (path === "active") {
      if (typeof operation.value !== "boolean") throw new Error("active must be boolean.");
      draft.active = operation.value;
    } else if (path === "name.givenname") {
      draft.givenName = optionalString(operation.value, "name.givenName");
    } else if (path === "name.familyname") {
      draft.familyName = optionalString(operation.value, "name.familyName");
    } else if (path === "name") {
      applyUserName(draft, objectValue(operation.value));
    } else if (path === "emails") {
      const emails = z
        .array(z.object({ value: z.string().email(), primary: z.boolean().optional() }))
        .parse(operation.value);
      const primary = emails.find((email) => email.primary === true) ?? emails[0];
      if (primary === undefined) throw new Error("emails must not be empty.");
      draft.userName = primary.value;
    } else if (path === `${USER_EXTENSION.toLowerCase()}.datatransfertargetid`) {
      draft.dataTransferTargetId = optionalUuid(operation.value);
    } else {
      throw new Error(`Unsupported User PATCH path: ${operation.path}.`);
    }
  }
  return draft;
}

function applyUserObject(
  draft: {
    externalId: string | null;
    userName: string;
    displayName: string;
    givenName: string | null;
    familyName: string | null;
    active: boolean;
    dataTransferTargetId?: string | null | undefined;
  },
  value: Record<string, unknown>,
): void {
  if ("userName" in value) draft.userName = requiredString(value.userName, "userName");
  if ("displayName" in value) draft.displayName = requiredString(value.displayName, "displayName");
  if ("externalId" in value) draft.externalId = optionalString(value.externalId, "externalId");
  if ("active" in value) {
    if (typeof value.active !== "boolean") throw new Error("active must be boolean.");
    draft.active = value.active;
  }
  if ("name" in value) applyUserName(draft, objectValue(value.name));
  const extension = value[USER_EXTENSION];
  if (extension !== undefined) {
    const extensionObject = objectValue(extension);
    if ("dataTransferTargetId" in extensionObject) {
      draft.dataTransferTargetId = optionalUuid(extensionObject.dataTransferTargetId);
    }
  }
}

function applyUserName(
  draft: { givenName: string | null; familyName: string | null; displayName: string },
  value: Record<string, unknown>,
): void {
  if ("givenName" in value) draft.givenName = optionalString(value.givenName, "name.givenName");
  if ("familyName" in value) draft.familyName = optionalString(value.familyName, "name.familyName");
  if ("formatted" in value) draft.displayName = requiredString(value.formatted, "name.formatted");
}

function applyGroupPatch(
  current: ScimGroupRecord,
  operations: readonly PatchOperation[],
): PutScimGroup {
  const draft = {
    externalId: current.externalId,
    displayName: current.displayName,
    memberIds: current.members.map((member) => member.value),
  };
  for (const operation of operations) {
    if (operation.path === undefined) {
      if (operation.op === "remove") throw new Error("A remove operation requires a path.");
      const value = objectValue(operation.value);
      if ("displayName" in value)
        draft.displayName = requiredString(value.displayName, "displayName");
      if ("externalId" in value) draft.externalId = optionalString(value.externalId, "externalId");
      if ("members" in value) draft.memberIds = memberIds(value.members);
      continue;
    }
    const path = operation.path.toLowerCase();
    const memberFilter = /^members\s*\[\s*value\s+eq\s+"([0-9a-f-]+)"\s*\]$/iu.exec(operation.path);
    if (memberFilter?.[1] !== undefined && operation.op === "remove") {
      const id = optionalUuid(memberFilter[1]);
      if (id !== null) draft.memberIds = draft.memberIds.filter((memberId) => memberId !== id);
    } else if (path === "members") {
      if (operation.op === "remove") draft.memberIds = [];
      else {
        const ids = memberIds(operation.value);
        draft.memberIds = operation.op === "add" ? [...new Set([...draft.memberIds, ...ids])] : ids;
      }
    } else if (path === "displayname" && operation.op !== "remove") {
      draft.displayName = requiredString(operation.value, "displayName");
    } else if (path === "externalid") {
      draft.externalId =
        operation.op === "remove" ? null : optionalString(operation.value, "externalId");
    } else {
      throw new Error(`Unsupported Group PATCH path: ${operation.path}.`);
    }
  }
  return draft;
}

function memberIds(value: unknown): string[] {
  return z
    .array(z.object({ value: z.string().uuid() }))
    .max(10_000)
    .parse(value)
    .map((member) => member.value);
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("PATCH value must be an object.");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, attribute: string): string {
  const parsed = z.string().trim().min(1).max(320).safeParse(value);
  if (!parsed.success) throw new Error(`${attribute} must be a non-empty string.`);
  return parsed.data;
}

function optionalString(value: unknown, attribute: string): string | null {
  if (value === null) return null;
  return requiredString(value, attribute);
}

function optionalUuid(value: unknown): string | null {
  if (value === null) return null;
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw new Error("dataTransferTargetId must be a UUID.");
  return parsed.data;
}

function userResource(user: ScimUserRecord, slug: string) {
  const location = `/api/scim/v2/${slug}/Users/${user.id}`;
  return {
    schemas: user.dataTransferTargetId === null ? [USER_SCHEMA] : [USER_SCHEMA, USER_EXTENSION],
    id: user.id,
    ...(user.externalId === null ? {} : { externalId: user.externalId }),
    userName: user.userName,
    displayName: user.displayName,
    name: {
      formatted: user.displayName,
      ...(user.givenName === null ? {} : { givenName: user.givenName }),
      ...(user.familyName === null ? {} : { familyName: user.familyName }),
    },
    emails: [{ value: user.userName, type: "work", primary: true }],
    active: user.active,
    ...(user.dataTransferTargetId === null
      ? {}
      : { [USER_EXTENSION]: { dataTransferTargetId: user.dataTransferTargetId } }),
    meta: scimMeta("User", user.createdAt, user.updatedAt, user.version, location),
  };
}

function groupResource(group: ScimGroupRecord, slug: string) {
  const location = `/api/scim/v2/${slug}/Groups/${group.id}`;
  return {
    schemas: [GROUP_SCHEMA],
    id: group.id,
    ...(group.externalId === null ? {} : { externalId: group.externalId }),
    displayName: group.displayName,
    members: group.members.map((member) => ({
      value: member.value,
      display: member.display,
      $ref: `/api/scim/v2/${slug}/Users/${member.value}`,
    })),
    meta: scimMeta("Group", group.createdAt, group.updatedAt, group.version, location),
  };
}

function scimMeta(
  resourceType: string,
  created: Date,
  updated: Date,
  version: number,
  location: string,
) {
  return {
    resourceType,
    created: created.toISOString(),
    lastModified: updated.toISOString(),
    version: etag(version),
    location,
  };
}

function etag(version: number): string {
  return `W/"${String(version)}"`;
}

function sendResource(
  reply: FastifyReply,
  status: number,
  resource: { readonly meta: { readonly version: string; readonly location: string } },
) {
  return reply
    .code(status)
    .header("etag", resource.meta.version)
    .header("location", resource.meta.location)
    .header("cache-control", "no-store")
    .header("content-type", SCIM_JSON)
    .send(resource);
}

function sendScim(reply: FastifyReply, status: number, body: unknown) {
  return reply
    .code(status)
    .header("cache-control", "no-store")
    .header("content-type", SCIM_JSON)
    .send(body);
}

function sendScimError(reply: FastifyReply, status: number, detail: string, scimType?: string) {
  return sendScim(reply, status, scimError(status, detail, scimType));
}

function invalidBody(reply: FastifyReply, detail: string) {
  return sendScimError(reply, 400, detail, "invalidValue");
}

function handleWriteError(reply: FastifyReply, error: unknown) {
  if (error instanceof ScimConflictError)
    return sendScimError(reply, 409, error.message, "uniqueness");
  if (error instanceof ScimPreconditionError) return sendScimError(reply, 412, error.message);
  throw error;
}

function serviceProviderConfig(documentationUri: string | undefined) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    ...(documentationUri === undefined ? {} : { documentationUri }),
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: true },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description: "Per-tenant SCIM bearer token.",
        specUri: "https://www.rfc-editor.org/rfc/rfc6750",
        primary: true,
      },
    ],
  };
}

function resourceTypes(tenantSlug: string) {
  return [
    {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
      id: "User",
      name: "User",
      endpoint: `/api/scim/v2/${tenantSlug}/Users`,
      schema: "urn:ietf:params:scim:schemas:core:2.0:User",
      schemaExtensions: [{ schema: USER_EXTENSION, required: false }],
    },
    {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
      id: "Group",
      name: "Group",
      endpoint: `/api/scim/v2/${tenantSlug}/Groups`,
      schema: "urn:ietf:params:scim:schemas:core:2.0:Group",
      schemaExtensions: [],
    },
  ];
}

function scimSchemas() {
  return [
    {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
      id: "urn:ietf:params:scim:schemas:core:2.0:User",
      name: "User",
      description: "User account representation.",
      attributes: [
        {
          name: "userName",
          type: "string",
          multiValued: false,
          required: true,
          mutability: "readWrite",
        },
        {
          name: "active",
          type: "boolean",
          multiValued: false,
          required: false,
          mutability: "readWrite",
        },
        {
          name: "name",
          type: "complex",
          multiValued: false,
          required: false,
          mutability: "readWrite",
        },
        {
          name: "emails",
          type: "complex",
          multiValued: true,
          required: false,
          mutability: "readWrite",
        },
        {
          name: "externalId",
          type: "string",
          multiValued: false,
          required: false,
          mutability: "readWrite",
        },
      ],
    },
    {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
      id: "urn:ietf:params:scim:schemas:core:2.0:Group",
      name: "Group",
      description: "Group representation.",
      attributes: [
        {
          name: "displayName",
          type: "string",
          multiValued: false,
          required: true,
          mutability: "readWrite",
        },
        {
          name: "members",
          type: "complex",
          multiValued: true,
          required: false,
          mutability: "readWrite",
        },
        {
          name: "externalId",
          type: "string",
          multiValued: false,
          required: false,
          mutability: "readWrite",
        },
      ],
    },
    {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
      id: USER_EXTENSION,
      name: "HelixUser",
      description: "Helix deprovisioning and data-transfer attributes.",
      attributes: [
        {
          name: "dataTransferTargetId",
          type: "string",
          multiValued: false,
          required: false,
          mutability: "readWrite",
        },
      ],
    },
  ];
}

function scimListResponse<T>(resources: readonly T[]) {
  return {
    schemas: [LIST_RESPONSE_SCHEMA],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

function scimError(status: number, detail: string, scimType?: string) {
  return {
    schemas: [ERROR_SCHEMA],
    status: String(status),
    detail,
    ...(scimType === undefined ? {} : { scimType }),
  };
}
