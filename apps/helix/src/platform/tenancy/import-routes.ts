import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  adminWildcardScope,
  auditAdminAction,
  forbidden,
  invalidRequest,
  notFound,
  type AdminConsoleAuditSink,
} from "../admin/console-shared.js";
import {
  buildTenantImportPlanFromArchive,
  type TenantImportDryRunConflictPolicy,
  type TenantImportPlanTargetState,
} from "./import-plan.js";
import type { OrgRecord, OrgStore } from "./orgs.js";

export const adminTenantsImportScope = "admin.tenants.import";

export interface RegisterTenantImportRoutesOptions {
  readonly orgs: Pick<OrgStore, "findBySlug">;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly targetStateLoader: (org: OrgRecord) => Promise<TenantImportPlanTargetState>;
  readonly auditSink?: AdminConsoleAuditSink | undefined;
}

const tenantParams = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u),
});

const conflictPolicyQuery = z
  .object({
    rowIdConflicts: z.enum(["regenerate", "preserve"]).optional(),
    principalReferences: z.enum(["preserve", "null"]).optional(),
    resourceReferences: z.enum(["require-remap", "preserve"]).optional(),
    verifiedState: z.enum(["regenerate", "preserve"]).optional(),
    primaryDomain: z.enum(["preserve", "null"]).optional(),
  })
  .strict();

export async function registerTenantImportRoutes(
  app: FastifyInstance,
  options: RegisterTenantImportRoutesOptions,
): Promise<void> {
  safeAddContentTypeParser(app, "application/x-tar");
  safeAddContentTypeParser(app, "application/octet-stream");

  app.post("/api/admin/tenants/:slug/import/dry-run", async (request, reply) => {
    const loaded = await loadTenantForImport({ request, reply, options });
    if (loaded === undefined) {
      return reply;
    }
    const query = conflictPolicyQuery.safeParse(request.query);
    if (!query.success) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid tenant import conflict-policy query.", query.error.issues));
    }
    const archive = requestBodyBytes(request.body);
    if (archive === undefined) {
      return reply
        .code(400)
        .send(invalidRequest("Tenant import dry-run requires a non-empty tar archive body."));
    }

    const targetState = await options.targetStateLoader(loaded.org);
    const result = buildTenantImportPlanFromArchive({
      archive,
      targetOrgId: loaded.org.id,
      targetSlug: loaded.org.slug,
      targetState,
      ...(hasConflictPolicyInput(query.data) ? { conflictPolicy: query.data } : {}),
    });
    await auditAdminAction(options.auditSink, {
      orgId: loaded.org.id,
      actorId: loaded.actor.id,
      verb: "tenant.import.dry_run.planned",
      objectType: "tenant",
      objectId: loaded.org.id,
      metadata: {
        slug: loaded.org.slug,
        archiveByteSize: archive.byteLength,
        hasConflictPolicyInput: hasConflictPolicyInput(query.data),
        ok: result.ok,
        issueCount: result.issues.length + (result.plan?.issues.length ?? 0),
        operationCount: result.plan?.summary.operationCount ?? 0,
        conflictCount: result.plan?.summary.conflictCount ?? 0,
        remapCount: result.plan?.summary.remapCount ?? 0,
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      },
    });
    return reply.code(result.ok ? 200 : 422).send(result);
  });
}

async function loadTenantForImport(input: {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly options: RegisterTenantImportRoutesOptions;
}): Promise<{ readonly actor: Actor; readonly org: OrgRecord } | undefined> {
  const actor = await input.options.actorFromRequest(input.request);
  if (!hasImportScope(actor)) {
    sendImportForbidden(input.reply);
    return undefined;
  }
  const params = tenantParams.safeParse(input.request.params);
  if (!params.success) {
    input.reply.code(400).send(invalidRequest("Invalid tenant import slug.", params.error.issues));
    return undefined;
  }
  const org = await input.options.orgs.findBySlug(params.data.slug);
  if (org === null) {
    input.reply.code(404).send(notFound("Tenant not found."));
    return undefined;
  }
  if (org.id !== actor.orgId) {
    sendImportForbidden(input.reply);
    return undefined;
  }
  return { actor, org };
}

function hasImportScope(actor: Actor): boolean {
  const scopes = actor.scopes ?? [];
  return scopes.includes(adminTenantsImportScope) || scopes.includes(adminWildcardScope);
}

function sendImportForbidden(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({
    ...forbidden(adminTenantsImportScope),
    error: "Tenant import permission denied.",
  });
}

function requestBodyBytes(body: unknown): Uint8Array | undefined {
  if (body instanceof Uint8Array && body.byteLength > 0) {
    return body;
  }
  return undefined;
}

function hasConflictPolicyInput(policy: TenantImportDryRunConflictPolicy): boolean {
  return Object.values(policy).some((value) => value !== undefined);
}

function safeAddContentTypeParser(app: FastifyInstance, contentType: string): void {
  try {
    app.addContentTypeParser(contentType, { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });
  } catch {
    // Parser may already be registered by a sibling route module in tests.
  }
}
