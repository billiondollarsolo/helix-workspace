import { createHash } from "node:crypto";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  adminWildcardScope,
  auditAdminAction,
  cursorQuerySchema,
  decodeCursor,
  forbidden,
  invalidRequest,
  invalidCursor,
  notFound,
  limitQuerySchema,
  paginate,
  type AdminConsoleAuditSink,
} from "../admin/console-shared.js";
import type {
  TenantImportJobRecord,
  TenantImportJobResultSummary,
  TenantImportJobStatus,
  TenantImportJobStore,
} from "./import-jobs.js";
import {
  buildTenantImportPlanFromArchive,
  type TenantImportArchivePlanResult,
  type TenantImportDryRunConflictPolicy,
  type TenantImportPlanConflict,
  type TenantImportPlanIssue,
  type TenantImportPlanTargetState,
} from "./import-plan.js";
import type { OrgRecord, OrgStore } from "./orgs.js";

export const adminTenantsImportScope = "admin.tenants.import";

export interface RegisterTenantImportRoutesOptions {
  readonly orgs: Pick<OrgStore, "findBySlug">;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly targetStateLoader: (org: OrgRecord) => Promise<TenantImportPlanTargetState>;
  readonly importJobs?: TenantImportJobStore | undefined;
  readonly auditSink?: AdminConsoleAuditSink | undefined;
}

const tenantParams = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u),
});

const importJobParams = tenantParams.extend({
  jobId: z.string().uuid(),
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

const importJobListQuery = z.object({
  limit: limitQuerySchema,
  cursor: cursorQuerySchema,
  status: z.enum(["succeeded", "failed"]).optional(),
});

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
    const hasPolicyInput = hasConflictPolicyInput(query.data);
    const result = buildTenantImportPlanFromArchive({
      archive,
      targetOrgId: loaded.org.id,
      targetSlug: loaded.org.slug,
      targetState,
      ...(hasPolicyInput ? { conflictPolicy: query.data } : {}),
    });
    const importJob =
      options.importJobs === undefined
        ? undefined
        : await options.importJobs.create({
            orgId: loaded.org.id,
            requestedByActorId: loaded.actor.id,
            archiveByteSize: archive.byteLength,
            archiveSha256: sha256Hex(archive),
            hasConflictPolicyInput: hasPolicyInput,
            conflictPolicy: hasPolicyInput ? query.data : {},
            ok: result.ok,
            sourceOrgId: result.plan?.source.orgId ?? null,
            sourceSlug: result.plan?.source.slug ?? null,
            sourceGeneratedAt:
              result.plan === undefined ? null : new Date(result.plan.source.generatedAt),
            objectBytesMode: result.plan?.objectBytes.mode ?? null,
            issueCount: result.issues.length + (result.plan?.issues.length ?? 0),
            operationCount: result.plan?.summary.operationCount ?? 0,
            conflictCount: result.plan?.summary.conflictCount ?? 0,
            remapCount: result.plan?.summary.remapCount ?? 0,
            errorCode: importJobErrorCode(result),
            errorMessage: importJobErrorMessage(result),
            resultSummary: tenantImportJobResultSummary(result),
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
        hasConflictPolicyInput: hasPolicyInput,
        importJobId: importJob?.id ?? null,
        ok: result.ok,
        issueCount: result.issues.length + (result.plan?.issues.length ?? 0),
        operationCount: result.plan?.summary.operationCount ?? 0,
        conflictCount: result.plan?.summary.conflictCount ?? 0,
        remapCount: result.plan?.summary.remapCount ?? 0,
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      },
    });
    return reply
      .code(result.ok ? 200 : 422)
      .send(
        importJob === undefined ? result : { ...result, importJob: tenantImportJobView(importJob) },
      );
  });

  app.get("/api/admin/tenants/:slug/import/jobs", async (request, reply) => {
    const loaded = await loadTenantForImport({ request, reply, options });
    if (loaded === undefined) {
      return reply;
    }
    if (options.importJobs === undefined) {
      return reply.code(503).send(invalidRequest("Tenant import jobs are not configured.", []));
    }
    const query = importJobListQuery.safeParse(request.query ?? {});
    if (!query.success) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid tenant import job list request.", query.error.issues));
    }
    const cursor = query.data.cursor === undefined ? undefined : decodeCursor(query.data.cursor);
    if (cursor === null) {
      return reply.code(400).send(invalidCursor());
    }
    const limit = query.data.limit;
    const jobs = await options.importJobs.listForOrg({
      orgId: loaded.org.id,
      limit: limit + 1,
      ...(cursor === undefined ? {} : { cursor }),
      ...(query.data.status === undefined ? {} : { status: query.data.status }),
    });
    const page = paginate(
      jobs.map((job) => tenantImportJobView(job)),
      limit,
    );
    return { importJobs: page.items, nextCursor: page.nextCursor };
  });

  app.get("/api/admin/tenants/:slug/import/jobs/:jobId", async (request, reply) => {
    const loaded = await loadTenantForImport({ request, reply, options });
    if (loaded === undefined) {
      return reply;
    }
    if (options.importJobs === undefined) {
      return reply.code(503).send(invalidRequest("Tenant import jobs are not configured.", []));
    }
    const params = importJobParams.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid tenant import job id.", params.error.issues));
    }
    const job = await options.importJobs.findByIdForOrg({
      id: params.data.jobId,
      orgId: loaded.org.id,
    });
    if (job === null) {
      return reply.code(404).send(notFound("Tenant import job not found."));
    }
    return { importJob: tenantImportJobView(job) };
  });
}

export interface TenantImportJobView {
  readonly id: string;
  readonly orgId: string;
  readonly status: TenantImportJobStatus;
  readonly dryRun: true;
  readonly requestedByActorId: string | null;
  readonly archiveByteSize: number;
  readonly archiveSha256: string;
  readonly hasConflictPolicyInput: boolean;
  readonly conflictPolicy: TenantImportDryRunConflictPolicy;
  readonly ok: boolean;
  readonly sourceOrgId: string | null;
  readonly sourceSlug: string | null;
  readonly sourceGeneratedAt: string | null;
  readonly objectBytesMode: string | null;
  readonly issueCount: number;
  readonly operationCount: number;
  readonly conflictCount: number;
  readonly remapCount: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly resultSummary: TenantImportJobResultSummary;
  readonly completedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function tenantImportJobView(job: TenantImportJobRecord): TenantImportJobView {
  return {
    id: job.id,
    orgId: job.orgId,
    status: job.status,
    dryRun: job.dryRun,
    requestedByActorId: job.requestedByActorId,
    archiveByteSize: job.archiveByteSize,
    archiveSha256: job.archiveSha256,
    hasConflictPolicyInput: job.hasConflictPolicyInput,
    conflictPolicy: job.conflictPolicy,
    ok: job.ok,
    sourceOrgId: job.sourceOrgId,
    sourceSlug: job.sourceSlug,
    sourceGeneratedAt: job.sourceGeneratedAt?.toISOString() ?? null,
    objectBytesMode: job.objectBytesMode,
    issueCount: job.issueCount,
    operationCount: job.operationCount,
    conflictCount: job.conflictCount,
    remapCount: job.remapCount,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    resultSummary: job.resultSummary,
    completedAt: job.completedAt.toISOString(),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
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

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function importJobErrorCode(
  result: ReturnType<typeof buildTenantImportPlanFromArchive>,
): string | null {
  if (result.ok) {
    return null;
  }
  return (
    result.issues[0]?.code ??
    result.plan?.issues.find((issue) => issue.severity === "error")?.code ??
    null
  );
}

function importJobErrorMessage(
  result: ReturnType<typeof buildTenantImportPlanFromArchive>,
): string | null {
  if (result.ok) {
    return null;
  }
  return (
    result.issues[0]?.message ??
    result.plan?.issues.find((issue) => issue.severity === "error")?.message ??
    null
  );
}

function tenantImportJobResultSummary(
  result: TenantImportArchivePlanResult,
): TenantImportJobResultSummary {
  return {
    ok: result.ok,
    archiveIssues: result.issues.map((issue) => ({
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
      ...(issue.path === undefined ? {} : { path: issue.path }),
    })),
    plan:
      result.plan === undefined
        ? null
        : {
            source: result.plan.source,
            target: result.plan.target,
            objectBytes: result.plan.objectBytes,
            summary: result.plan.summary,
            issueCount: result.plan.issues.length,
            issues: result.plan.issues.map(tenantImportJobIssueSummary),
            conflictCount: result.plan.conflicts.length,
            conflicts: result.plan.conflicts.map(tenantImportJobConflictSummary),
          },
  };
}

function tenantImportJobIssueSummary(issue: TenantImportPlanIssue) {
  return {
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    ...(issue.path === undefined ? {} : { path: issue.path }),
    ...(issue.table === undefined ? {} : { table: issue.table }),
    ...(issue.field === undefined ? {} : { field: issue.field }),
    ...(issue.sourceId === undefined ? {} : { sourceId: issue.sourceId }),
  };
}

function tenantImportJobConflictSummary(conflict: TenantImportPlanConflict) {
  return {
    severity: conflict.severity,
    code: conflict.code,
    table: conflict.table,
    ...(conflict.sourceId === undefined ? {} : { sourceId: conflict.sourceId }),
    ...(conflict.targetId === undefined ? {} : { targetId: conflict.targetId }),
    ...(conflict.naturalKey === undefined ? {} : { naturalKey: conflict.naturalKey }),
    ...(conflict.field === undefined ? {} : { field: conflict.field }),
  };
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
