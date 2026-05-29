import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { OrgStore } from "../tenancy/orgs.js";
import {
  verifyScimBearerToken,
  type TenantScimCredentialStore,
} from "./scim-credentials.js";

/**
 * Audit sink consumed when a SCIM request fails authentication. Matches the
 * shape of `PostgresAuditStore.append` used elsewhere in the platform. The
 * sink is best-effort: audit failures must never leak through as a 500 to the
 * caller because that would re-introduce an enumeration oracle.
 */
export interface ScimAuthAuditSink {
  append(record: {
    readonly orgId: string;
    readonly actorId: string;
    readonly verb: string;
    readonly objectType: string;
    readonly objectId?: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface RegisterTenantScimRoutesOptions {
  readonly orgs: Pick<OrgStore, "findBySlug">;
  /**
   * Per-tenant SCIM bearer token store. When omitted, every SCIM request is
   * rejected with 401 - SCIM is opt-in per tenant and the absence of a store
   * means no tenant can provision tokens. (We still register the routes so
   * the surface returns a consistent SCIM error envelope.)
   */
  readonly credentials?: Pick<TenantScimCredentialStore, "findByOrgId"> | undefined;
  readonly auditSink?: ScimAuthAuditSink | undefined;
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

/**
 * Register the per-tenant SCIM v2 endpoints. Every endpoint enforces a
 * per-tenant bearer token before any tenant lookup so the surface cannot be
 * used as an enumeration oracle. Mutation routes intentionally return a 501
 * SCIM error envelope rather than faking success until the underlying
 * provisioning is implemented.
 */
export async function registerTenantScimRoutes(
  app: FastifyInstance,
  options: RegisterTenantScimRoutesOptions,
): Promise<void> {
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

  // Unimplemented provisioning endpoints. We deliberately register every
  // SCIM-spec verb (GET/POST/PUT/PATCH/DELETE, plus per-resource sub-paths)
  // and return a uniform 501 SCIM error envelope. Critically: stub mutation
  // routes never return 200/204 - pretending to succeed silently drops
  // upstream IdP changes and is worse than refusing to serve.
  const unimplemented = [
    { url: `${SCIM_BASE_PREFIX}/Users`, resource: "Users" },
    { url: `${SCIM_BASE_PREFIX}/Users/:resourceId`, resource: "Users" },
    { url: `${SCIM_BASE_PREFIX}/Groups`, resource: "Groups" },
    { url: `${SCIM_BASE_PREFIX}/Groups/:resourceId`, resource: "Groups" },
  ] as const;

  for (const entry of unimplemented) {
    app.route({
      method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      url: entry.url,
      handler: async (request, reply) => {
        const auth = await authenticateScimRequest(request, reply, options);
        if (!auth.ok) {
          return reply;
        }
        return reply
          .code(501)
          .header("content-type", SCIM_JSON)
          .send(
            scimError(
              501,
              `${entry.resource} SCIM provisioning is not implemented yet.`,
            ),
          );
      },
    });
  }
}

interface ScimAuthSuccess {
  readonly ok: true;
  readonly orgId: string;
  readonly slug: string;
}

interface ScimAuthFailure {
  readonly ok: false;
}

/**
 * Authenticate a SCIM request. Returns `{ ok: true }` only when:
 *
 *  1. The `Authorization: Bearer <token>` header is well-formed.
 *  2. The tenant slug parses and resolves to an active tenant.
 *  3. The tenant has a stored SCIM bearer-token hash.
 *  4. The presented token verifies against the stored hash (constant-time
 *     via `verifySecret`, which uses argon2 verify / `timingSafeEqual`).
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
    await recordScimAuthFailure(options.auditSink, request, "missing_bearer", null);
    sendScimUnauthorized(reply);
    return { ok: false };
  }

  // Parse the tenant slug shape before any DB lookup. A malformed slug must
  // still produce a 401, not a 400 - a 400 vs 401 difference would itself be
  // an enumeration oracle for which slugs match the regex.
  const parsedParams = scimTenantParams.safeParse(request.params);
  if (!parsedParams.success) {
    await recordScimAuthFailure(options.auditSink, request, "invalid_slug", null);
    sendScimUnauthorized(reply);
    return { ok: false };
  }
  const slug = parsedParams.data.tenantSlug;

  if (options.credentials === undefined) {
    await recordScimAuthFailure(options.auditSink, request, "credentials_unconfigured", null);
    sendScimUnauthorized(reply);
    return { ok: false };
  }

  const org = await options.orgs.findBySlug(slug);
  if (org === null || org.status !== "active") {
    await recordScimAuthFailure(
      options.auditSink,
      request,
      org === null ? "tenant_not_found" : "tenant_not_active",
      org?.id ?? null,
    );
    sendScimUnauthorized(reply);
    return { ok: false };
  }

  const credential = await options.credentials.findByOrgId(org.id);
  if (credential === null) {
    await recordScimAuthFailure(options.auditSink, request, "no_credential_configured", org.id);
    sendScimUnauthorized(reply);
    return { ok: false };
  }

  const valid = await verifyScimBearerToken(presentedToken, credential.tokenHash);
  if (!valid) {
    await recordScimAuthFailure(options.auditSink, request, "invalid_bearer", org.id);
    sendScimUnauthorized(reply);
    return { ok: false };
  }

  return { ok: true, orgId: org.id, slug: org.slug };
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

async function recordScimAuthFailure(
  sink: ScimAuthAuditSink | undefined,
  request: FastifyRequest,
  reason: string,
  orgId: string | null,
): Promise<void> {
  if (sink === undefined) {
    return;
  }
  // Never log token bytes. Capture only the request shape: source IP, the
  // path family (so /Users vs /Groups is visible), the HTTP method, the
  // user-agent (already public), and a coarse failure reason.
  const sourceIp = clientIp(request);
  const userAgent = headerString(request.headers["user-agent"]);
  try {
    await sink.append({
      orgId: orgId ?? "00000000-0000-0000-0000-000000000000",
      actorId: "scim-anonymous",
      verb: "scim.auth.failed",
      objectType: "scim_endpoint",
      objectId: request.routeOptions?.url ?? request.url,
      metadata: {
        method: request.method,
        path: request.url,
        reason,
        sourceIp,
        ...(userAgent === null ? {} : { userAgent }),
      },
    });
  } catch {
    // Audit failures must not surface to the SCIM caller.
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

function clientIp(request: FastifyRequest): string {
  const forwarded = headerString(request.headers["x-forwarded-for"]);
  if (forwarded !== null) {
    const first = forwarded.split(",")[0];
    if (first !== undefined && first.trim().length > 0) {
      return first.trim();
    }
  }
  return request.ip;
}

function serviceProviderConfig(documentationUri: string | undefined) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    ...(documentationUri === undefined ? {} : { documentationUri }),
    patch: { supported: false },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: false, maxResults: 0 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description:
          "Per-tenant SCIM bearer token. Rotation UI and provisioning writes are pending.",
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
      schemaExtensions: [],
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
      id: "urn:ietf:params:scim:schemas:core:2.0:User",
      name: "User",
      description: "User account representation. CRUD provisioning is pending.",
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
      id: "urn:ietf:params:scim:schemas:core:2.0:Group",
      name: "Group",
      description: "Group representation. CRUD provisioning is pending.",
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

function scimError(status: number, detail: string) {
  return {
    schemas: [ERROR_SCHEMA],
    status: String(status),
    detail,
  };
}
