import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ipMatchesCidr } from "../auth/credentials.js";
import {
  SCIM_CREDENTIAL_SCOPES,
  ScimCredentialConflictError,
  issueScimBearerToken,
  type ScimCredentialScope,
  type TenantScimCredentialRecord,
  type TenantScimCredentialStore,
} from "../auth/scim-credentials.js";
import {
  adminConsoleReadScope,
  adminConsoleWriteScope,
  auditAdminAction,
  canReadAdminConsole,
  canWriteAdminConsole,
  conflict,
  invalidRequest,
  notFound,
  sendForbidden,
  type AdminConsoleAuditSink,
} from "./console-shared.js";

export interface RegisterAdminScimCredentialRoutesOptions {
  readonly credentials: TenantScimCredentialStore;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly auditSink: AdminConsoleAuditSink;
}

const scopeSchema = z.enum(SCIM_CREDENTIAL_SCOPES);
const sourceCidrSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .refine((value) => {
    const address = value.split("/", 1)[0];
    return address !== undefined && ipMatchesCidr(address, value);
  }, "Source policy entries must be IPv4/IPv6 addresses or CIDRs.");
const createBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    scopes: z
      .array(scopeSchema)
      .min(1)
      .max(SCIM_CREDENTIAL_SCOPES.length)
      .refine((scopes) => new Set(scopes).size === scopes.length, "Scopes must be unique.")
      .default([...SCIM_CREDENTIAL_SCOPES]),
    sourceCidrs: z
      .array(sourceCidrSchema)
      .max(50)
      .refine((cidrs) => new Set(cidrs).size === cidrs.length, "Source CIDRs must be unique.")
      .default([]),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
const idParams = z.object({ id: z.string().uuid() });
const MAX_LIFETIME_MS = 366 * 24 * 60 * 60 * 1000;
const DEFAULT_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

export async function registerAdminScimCredentialRoutes(
  app: FastifyInstance,
  options: RegisterAdminScimCredentialRoutesOptions,
): Promise<void> {
  app.get("/api/admin/identity/scim-credentials", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminConsole(actor)) return sendForbidden(reply, adminConsoleReadScope);
    const credentials = await options.credentials.list(actor.orgId);
    return reply
      .header("cache-control", "no-store")
      .send({ credentials: credentials.map(credentialView) });
  });

  app.post("/api/admin/identity/scim-credentials", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) return sendForbidden(reply, adminConsoleWriteScope);
    const body = createBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid SCIM credential.", body.error.issues));
    }
    const now = new Date();
    const expiresAt = body.data.expiresAt
      ? new Date(body.data.expiresAt)
      : new Date(now.getTime() + DEFAULT_LIFETIME_MS);
    if (expiresAt <= now || expiresAt.getTime() - now.getTime() > MAX_LIFETIME_MS) {
      return reply
        .code(400)
        .send(invalidRequest("SCIM credential expiry must be within the next 366 days."));
    }
    const issued = await issueScimBearerToken();
    let credential: TenantScimCredentialRecord;
    try {
      credential = await options.credentials.create({
        id: issued.id,
        orgId: actor.orgId,
        name: body.data.name,
        tokenHash: issued.tokenHash,
        tokenHint: issued.tokenHint,
        scopes: body.data.scopes,
        sourceCidrs: body.data.sourceCidrs,
        expiresAt,
        createdByActorId: actor.id,
      });
    } catch (error) {
      if (!(error instanceof ScimCredentialConflictError)) throw error;
      return reply.code(409).send(conflict(error.message));
    }
    await auditAdminAction(options.auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.identity.scim_credential.created",
      objectType: "scim_credential",
      objectId: credential.id,
      metadata: {
        name: credential.name,
        scopes: [...credential.scopes],
        sourceCidrs: [...credential.sourceCidrs],
        expiresAt: credential.expiresAt.toISOString(),
      },
    });
    return reply
      .code(201)
      .header("cache-control", "no-store")
      .send({ credential: credentialView(credential), token: issued.token });
  });

  app.post("/api/admin/identity/scim-credentials/:id/revoke", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) return sendForbidden(reply, adminConsoleWriteScope);
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid SCIM credential id."));
    }
    const credential = await options.credentials.revoke(actor.orgId, params.data.id, actor.id);
    if (credential === null) {
      return reply.code(404).send(notFound("SCIM credential not found."));
    }
    await auditAdminAction(options.auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.identity.scim_credential.revoked",
      objectType: "scim_credential",
      objectId: credential.id,
      metadata: { name: credential.name },
    });
    return reply
      .header("cache-control", "no-store")
      .send({ credential: credentialView(credential) });
  });
}

function credentialView(record: TenantScimCredentialRecord) {
  return {
    id: record.id,
    name: record.name,
    tokenHint: record.tokenHint,
    scopes: [...record.scopes],
    sourceCidrs: [...record.sourceCidrs],
    expiresAt: record.expiresAt.toISOString(),
    revokedAt: record.revokedAt?.toISOString() ?? null,
    revokedByActorId: record.revokedByActorId,
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: record.lastUsedIp,
    createdByActorId: record.createdByActorId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  } satisfies Record<string, unknown> & { readonly scopes: readonly ScimCredentialScope[] };
}
