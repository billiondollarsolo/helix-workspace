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
  TenantImportJobExecutionSummary,
  TenantImportJobRemapInputSummary,
  TenantImportJobResultSummary,
  TenantImportJobStatus,
  TenantImportJobStore,
} from "./import-jobs.js";
import {
  buildTenantImportAuditContinuityPlan,
  type TenantImportAuditContinuityStore,
} from "./import-audit-continuity.js";
import {
  executeTenantImportPreparedPlan,
  tenantImportExecutionConfirmation,
  type TenantImportExecutionBlocker,
  type TenantImportExecutionResult,
  type TenantImportExecutionStage,
} from "./import-execution.js";
import {
  buildTenantImportObjectRestorePlan,
  type TenantImportSelfFetchDownloader,
} from "./import-object-restore.js";
import {
  buildTenantImportPlan,
  buildTenantImportPlanFromArchive,
  type TenantImportArchivePlanResult,
  type TenantImportDryRunConflictPolicy,
  type TenantImportPlanConflict,
  type TenantImportPlanIssue,
  type TenantImportPlanProvidedRemaps,
  type TenantImportPlanTargetState,
  readTenantImportPreparedArchive,
} from "./import-plan.js";
import type { TenantImportRowApplyStore } from "./import-row-apply.js";
import type { OrgRecord, OrgStore } from "./orgs.js";
import type { TenantStorageResolver } from "../storage/tenant-resolver.js";

export const adminTenantsImportScope = "admin.tenants.import";

export interface RegisterTenantImportRoutesOptions {
  readonly orgs: Pick<OrgStore, "findBySlug">;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly targetStateLoader: (org: OrgRecord) => Promise<TenantImportPlanTargetState>;
  readonly importJobs?: TenantImportJobStore | undefined;
  readonly auditSink?: AdminConsoleAuditSink | undefined;
  readonly rowApplyStore?: TenantImportRowApplyStore | undefined;
  readonly storageResolver?: TenantStorageResolver | undefined;
  readonly auditContinuityStore?: TenantImportAuditContinuityStore | undefined;
  readonly selfFetchDownloader?: TenantImportSelfFetchDownloader | undefined;
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

const remapsSchema = z
  .object({
    principals: z.record(z.string().uuid(), z.union([z.string().uuid(), z.null()])).optional(),
    resources: z.record(z.string().min(1).max(500), z.string().min(1).max(500)).optional(),
  })
  .strict();

const remapsQuerySchema = z
  .string()
  .trim()
  .min(1)
  .max(65_536)
  .transform((value, ctx) => {
    try {
      return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Remaps must be base64url-encoded JSON.",
      });
      return z.NEVER;
    }
  })
  .pipe(remapsSchema);

const importDryRunQuery = conflictPolicyQuery.extend({
  remaps: remapsQuerySchema.optional(),
});

const importExecuteQuery = importDryRunQuery.extend({
  confirm: z.literal(tenantImportExecutionConfirmation),
});

const importJobListQuery = z.object({
  limit: limitQuerySchema,
  cursor: cursorQuerySchema,
  status: z.enum(["succeeded", "failed", "blocked"]).optional(),
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
    const query = importDryRunQuery.safeParse(request.query);
    if (!query.success) {
      const message = hasRemapsQueryInput(request.query)
        ? "Invalid tenant import remaps query."
        : "Invalid tenant import conflict-policy query.";
      return reply.code(400).send(invalidRequest(message, query.error.issues));
    }
    const archive = requestBodyBytes(request.body);
    if (archive === undefined) {
      return reply
        .code(400)
        .send(invalidRequest("Tenant import dry-run requires a non-empty tar archive body."));
    }

    const targetState = await options.targetStateLoader(loaded.org);
    const { remaps, ...conflictPolicy } = query.data;
    const hasPolicyInput = hasConflictPolicyInput(conflictPolicy);
    const remapSummary = remapInputSummary(remaps);
    const hasRemapInput = remapSummary.sha256 !== null;
    const result = buildTenantImportPlanFromArchive({
      archive,
      targetOrgId: loaded.org.id,
      targetSlug: loaded.org.slug,
      targetState,
      ...(hasPolicyInput ? { conflictPolicy } : {}),
      ...(hasRemapInput ? { remaps } : {}),
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
            conflictPolicy: hasPolicyInput ? conflictPolicy : {},
            hasRemapInput,
            remapInputSummary: remapSummary,
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
        hasRemapInput,
        remapInputPrincipalCount: remapSummary.principalCount,
        remapInputResourceCount: remapSummary.resourceCount,
        remapInputSha256: remapSummary.sha256,
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

  app.post("/api/admin/tenants/:slug/import/execute", async (request, reply) => {
    const loaded = await loadTenantForImport({ request, reply, options });
    if (loaded === undefined) {
      return reply;
    }
    const query = importExecuteQuery.safeParse(request.query);
    if (!query.success) {
      const message = hasRemapsQueryInput(request.query)
        ? "Invalid tenant import remaps query."
        : "Invalid tenant import execution query.";
      return reply.code(400).send(invalidRequest(message, query.error.issues));
    }
    const archiveBytes = requestBodyBytes(request.body);
    if (archiveBytes === undefined) {
      return reply
        .code(400)
        .send(invalidRequest("Tenant import execute requires a non-empty tar archive body."));
    }
    const executeDependencies = importExecuteDependencies(options);
    if (typeof executeDependencies === "string") {
      return reply
        .code(503)
        .send(invalidRequest(`Tenant import execution is not configured: ${executeDependencies}.`));
    }

    const archiveSha256 = sha256Hex(archiveBytes);
    const { confirm, remaps, ...conflictPolicy } = query.data;
    const hasPolicyInput = hasConflictPolicyInput(conflictPolicy);
    const remapSummary = remapInputSummary(remaps);
    const hasRemapInput = remapSummary.sha256 !== null;
    const targetState = await options.targetStateLoader(loaded.org);
    const prepared = readTenantImportPreparedArchive(archiveBytes);
    const planResult: TenantImportArchivePlanResult = prepared.ok
      ? (() => {
          const plan = buildTenantImportPlan({
            manifest: prepared.archive.manifest,
            files: prepared.archive.rowChunkFiles,
            targetOrgId: loaded.org.id,
            targetSlug: loaded.org.slug,
            targetState,
            ...(hasPolicyInput ? { conflictPolicy } : {}),
            ...(hasRemapInput ? { remaps } : {}),
          });
          return { ok: plan.ok, issues: [], plan };
        })()
      : { ok: false, issues: prepared.issues };

    let execution: TenantImportExecutionResult;
    if (!prepared.ok || planResult.plan === undefined) {
      execution = tenantImportBlockedExecution(
        "preflight",
        "archive_read_failed",
        "Tenant import execution requires a readable tenant export archive.",
      );
    } else {
      const objectRestorePlan = await buildTenantImportObjectRestorePlan({
        manifest: prepared.archive.manifest,
        archiveEntries: prepared.archive.entries,
        selfFetchManifest: prepared.archive.selfFetchManifest,
      });
      const targetChainHead =
        await executeDependencies.auditContinuityStore.getLatestAuditChainHead(loaded.org.id);
      const auditContinuityPlan = buildTenantImportAuditContinuityPlan({
        manifest: prepared.archive.manifest,
        targetOrgId: loaded.org.id,
        targetSlug: loaded.org.slug,
        targetChainHead,
        archiveSha256,
      });
      const storage = await executeDependencies.storageResolver({ orgId: loaded.org.id });
      execution =
        storage === undefined
          ? tenantImportBlockedExecution(
              "preflight",
              "tenant_storage_unresolved",
              "Tenant import execution requires resolved target tenant storage.",
            )
          : await executeTenantImportPreparedPlan({
              confirmation: confirm,
              plan: planResult.plan,
              rowApplyStore: executeDependencies.rowApplyStore,
              objectRestorePlan,
              objectArchiveEntries: prepared.archive.entries,
              objectStorage: storage.client,
              selfFetchDownloader: executeDependencies.selfFetchDownloader,
              auditContinuityPlan,
              auditSink: executeDependencies.auditSink,
              actorId: loaded.actor.id,
            });
    }

    const importJob = await executeDependencies.importJobs.create({
      orgId: loaded.org.id,
      status: execution.status,
      dryRun: false,
      requestedByActorId: loaded.actor.id,
      archiveByteSize: archiveBytes.byteLength,
      archiveSha256,
      hasConflictPolicyInput: hasPolicyInput,
      conflictPolicy: hasPolicyInput ? conflictPolicy : {},
      hasRemapInput,
      remapInputSummary: remapSummary,
      ok: execution.ok,
      sourceOrgId: planResult.plan?.source.orgId ?? null,
      sourceSlug: planResult.plan?.source.slug ?? null,
      sourceGeneratedAt:
        planResult.plan === undefined ? null : new Date(planResult.plan.source.generatedAt),
      objectBytesMode: planResult.plan?.objectBytes.mode ?? null,
      issueCount:
        planResult.issues.length +
        (planResult.plan?.issues.length ?? 0) +
        execution.blockers.length,
      operationCount: planResult.plan?.summary.operationCount ?? 0,
      conflictCount: planResult.plan?.summary.conflictCount ?? 0,
      remapCount: planResult.plan?.summary.remapCount ?? 0,
      errorCode: tenantImportExecutionErrorCode(planResult, execution),
      errorMessage: tenantImportExecutionErrorMessage(planResult, execution),
      resultSummary: tenantImportJobResultSummary(planResult, execution),
    });
    await auditAdminAction(options.auditSink, {
      orgId: loaded.org.id,
      actorId: loaded.actor.id,
      verb: "tenant.import.execution.completed",
      objectType: "tenant",
      objectId: loaded.org.id,
      metadata: {
        slug: loaded.org.slug,
        archiveByteSize: archiveBytes.byteLength,
        archiveSha256,
        importJobId: importJob.id,
        status: execution.status,
        ok: execution.ok,
        stoppedAt: execution.stoppedAt,
        blockerCount: execution.blockers.length,
        issueCount:
          planResult.issues.length +
          (planResult.plan?.issues.length ?? 0) +
          execution.blockers.length,
        operationCount: planResult.plan?.summary.operationCount ?? 0,
        conflictCount: planResult.plan?.summary.conflictCount ?? 0,
        remapCount: planResult.plan?.summary.remapCount ?? 0,
        hasConflictPolicyInput: hasPolicyInput,
        hasRemapInput,
        remapInputPrincipalCount: remapSummary.principalCount,
        remapInputResourceCount: remapSummary.resourceCount,
        remapInputSha256: remapSummary.sha256,
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      },
    });
    return reply.code(tenantImportExecutionHttpStatus(execution)).send({
      ...planResult,
      ok: execution.ok,
      execution,
      importJob: tenantImportJobView(importJob),
    });
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
  readonly dryRun: boolean;
  readonly requestedByActorId: string | null;
  readonly archiveByteSize: number;
  readonly archiveSha256: string;
  readonly hasConflictPolicyInput: boolean;
  readonly conflictPolicy: TenantImportDryRunConflictPolicy;
  readonly hasRemapInput: boolean;
  readonly remapInputSummary: TenantImportJobRemapInputSummary;
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
    hasRemapInput: job.hasRemapInput,
    remapInputSummary: job.remapInputSummary,
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

interface TenantImportExecuteDependencies {
  readonly importJobs: TenantImportJobStore;
  readonly auditSink: AdminConsoleAuditSink;
  readonly rowApplyStore: TenantImportRowApplyStore;
  readonly storageResolver: TenantStorageResolver;
  readonly auditContinuityStore: TenantImportAuditContinuityStore;
  readonly selfFetchDownloader?: TenantImportSelfFetchDownloader | undefined;
}

function importExecuteDependencies(
  options: RegisterTenantImportRoutesOptions,
): TenantImportExecuteDependencies | string {
  if (options.importJobs === undefined) {
    return "import jobs are missing";
  }
  if (options.auditSink === undefined) {
    return "audit sink is missing";
  }
  if (options.rowApplyStore === undefined) {
    return "row apply store is missing";
  }
  if (options.storageResolver === undefined) {
    return "tenant storage resolver is missing";
  }
  if (options.auditContinuityStore === undefined) {
    return "audit continuity store is missing";
  }
  return {
    importJobs: options.importJobs,
    auditSink: options.auditSink,
    rowApplyStore: options.rowApplyStore,
    storageResolver: options.storageResolver,
    auditContinuityStore: options.auditContinuityStore,
    ...(options.selfFetchDownloader === undefined
      ? {}
      : { selfFetchDownloader: options.selfFetchDownloader }),
  };
}

function tenantImportBlockedExecution(
  stage: TenantImportExecutionStage,
  code: string,
  message: string,
): TenantImportExecutionResult {
  return {
    ok: false,
    status: "blocked",
    stoppedAt: stage,
    blockers: [{ stage, code, message }],
    rowApply: null,
    objectRestore: null,
    auditContinuity: null,
  };
}

function tenantImportExecutionHttpStatus(execution: TenantImportExecutionResult): number {
  switch (execution.status) {
    case "succeeded":
      return 200;
    case "blocked":
      return 422;
    case "failed":
      return 500;
  }
}

function tenantImportExecutionErrorCode(
  result: TenantImportArchivePlanResult,
  execution: TenantImportExecutionResult,
): string | null {
  if (execution.ok) {
    return null;
  }
  return execution.blockers[0]?.code ?? importJobErrorCode(result);
}

function tenantImportExecutionErrorMessage(
  result: TenantImportArchivePlanResult,
  execution: TenantImportExecutionResult,
): string | null {
  if (execution.ok) {
    return null;
  }
  return execution.blockers[0]?.message ?? importJobErrorMessage(result);
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

function hasRemapsQueryInput(query: unknown): boolean {
  return typeof query === "object" && query !== null && "remaps" in query;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function remapInputSummary(
  remaps: TenantImportPlanProvidedRemaps | undefined,
): TenantImportJobRemapInputSummary {
  const principalCount = Object.keys(remaps?.principals ?? {}).length;
  const resourceCount = Object.keys(remaps?.resources ?? {}).length;
  if (principalCount === 0 && resourceCount === 0) {
    return { principalCount: 0, resourceCount: 0, sha256: null };
  }
  return {
    principalCount,
    resourceCount,
    sha256: sha256Hex(Buffer.from(stableJson(remaps), "utf8")),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
  execution?: TenantImportExecutionResult,
): TenantImportJobResultSummary {
  return {
    ok: execution?.ok ?? result.ok,
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
    ...(execution === undefined ? {} : { execution: tenantImportJobExecutionSummary(execution) }),
  };
}

function tenantImportJobExecutionSummary(
  execution: TenantImportExecutionResult,
): TenantImportJobExecutionSummary {
  return {
    status: execution.status,
    stoppedAt: execution.stoppedAt,
    blockers: execution.blockers.map(tenantImportJobExecutionBlockerSummary),
    rowApply:
      execution.rowApply === null
        ? null
        : {
            summary: execution.rowApply.summary,
            operations: execution.rowApply.operations,
          },
    objectRestore:
      execution.objectRestore === null
        ? null
        : {
            summary: execution.objectRestore.summary,
            operations: execution.objectRestore.operations,
          },
    auditContinuity:
      execution.auditContinuity === null
        ? null
        : {
            ok: execution.auditContinuity.ok,
            markerAuditId: execution.auditContinuity.markerAuditId,
            markerHash: execution.auditContinuity.markerHash,
          },
  };
}

function tenantImportJobExecutionBlockerSummary(blocker: TenantImportExecutionBlocker) {
  return {
    stage: blocker.stage,
    code: blocker.code,
    message: blocker.message,
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
