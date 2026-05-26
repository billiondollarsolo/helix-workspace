import type { JsonObject } from "@helix/sdk-types";
import type { AdminConsoleAuditSink } from "../admin/console-shared.js";
import type { TenantStorageClient } from "../storage/tenant-resolver.js";
import type { TenantImportAuditContinuityPlan } from "./import-audit-continuity.js";
import type {
  TenantImportObjectRestorePlan,
  TenantImportSelfFetchDownloader,
} from "./import-object-restore.js";
import { restoreTenantImportObjectBytes } from "./import-object-restore.js";
import type { TenantImportPlan } from "./import-plan.js";
import type { TenantImportRowApplyStore } from "./import-row-apply.js";
import { applyTenantImportPlanRows } from "./import-row-apply.js";

export const tenantImportExecutionConfirmation = "EXECUTE_INTERNAL_TENANT_IMPORT";

export type TenantImportExecutionStage =
  | "preflight"
  | "row_apply"
  | "object_restore"
  | "audit_continuity";

export interface ExecuteTenantImportPreparedPlanInput {
  readonly confirmation: string;
  readonly plan: Pick<TenantImportPlan, "ok" | "issues" | "operations">;
  readonly rowApplyStore: TenantImportRowApplyStore;
  readonly objectRestorePlan: TenantImportObjectRestorePlan;
  readonly objectArchiveEntries: ReadonlyMap<string, Uint8Array>;
  readonly objectStorage: TenantStorageClient;
  readonly selfFetchDownloader?: TenantImportSelfFetchDownloader | undefined;
  readonly auditContinuityPlan: TenantImportAuditContinuityPlan;
  readonly auditSink: AdminConsoleAuditSink;
  readonly actorId: string;
}

export interface TenantImportExecutionResult {
  readonly ok: boolean;
  readonly status: "succeeded" | "blocked" | "failed";
  readonly stoppedAt: TenantImportExecutionStage | null;
  readonly blockers: readonly TenantImportExecutionBlocker[];
  readonly rowApply: Awaited<ReturnType<typeof applyTenantImportPlanRows>> | null;
  readonly objectRestore: Awaited<ReturnType<typeof restoreTenantImportObjectBytes>> | null;
  readonly auditContinuity: TenantImportExecutionAuditContinuityResult | null;
}

export interface TenantImportExecutionBlocker {
  readonly stage: TenantImportExecutionStage;
  readonly code: string;
  readonly message: string;
}

export interface TenantImportExecutionAuditContinuityResult {
  readonly ok: boolean;
  readonly markerAuditId: string | null;
  readonly markerHash: string | null;
}

export async function executeTenantImportPreparedPlan(
  input: ExecuteTenantImportPreparedPlanInput,
): Promise<TenantImportExecutionResult> {
  const blockers = preflightBlockers(input);
  if (blockers.length > 0) {
    return blocked("preflight", blockers);
  }

  let objectRestore: Awaited<ReturnType<typeof restoreTenantImportObjectBytes>>;
  try {
    objectRestore = await restoreTenantImportObjectBytes({
      plan: input.objectRestorePlan,
      archiveEntries: input.objectArchiveEntries,
      storage: input.objectStorage,
      selfFetchDownloader: input.selfFetchDownloader,
    });
  } catch (error) {
    return {
      ...failed("object_restore", [
        {
          stage: "object_restore",
          code: "object_restore_failed",
          message: errorMessage(error),
        },
      ]),
    };
  }
  if (!objectRestore.ok) {
    return {
      ...blocked("object_restore", [
        {
          stage: "object_restore",
          code: "object_restore_blocked",
          message: "One or more tenant import object restore operations were blocked.",
        },
      ]),
      objectRestore,
    };
  }

  let rowApply: Awaited<ReturnType<typeof applyTenantImportPlanRows>>;
  try {
    rowApply = await applyTenantImportPlanRows({
      plan: input.plan,
      store: input.rowApplyStore,
    });
  } catch (error) {
    return {
      ...failed("row_apply", [
        {
          stage: "row_apply",
          code: "row_apply_failed",
          message: errorMessage(error),
        },
      ]),
      objectRestore,
    };
  }
  if (!rowApply.ok) {
    return {
      ...blocked("row_apply", [
        {
          stage: "row_apply",
          code: "row_apply_blocked",
          message: "One or more tenant import row operations were blocked.",
        },
      ]),
      rowApply,
      objectRestore,
    };
  }

  let auditContinuity: TenantImportExecutionAuditContinuityResult;
  try {
    auditContinuity = await appendAuditContinuityMarker({
      plan: input.auditContinuityPlan,
      auditSink: input.auditSink,
      actorId: input.actorId,
      rowApplySummary: rowApply.summary,
      objectRestoreSummary: objectRestore.summary,
    });
  } catch (error) {
    return {
      ...failed("audit_continuity", [
        {
          stage: "audit_continuity",
          code: "audit_continuity_failed",
          message: errorMessage(error),
        },
      ]),
      rowApply,
      objectRestore,
    };
  }

  return {
    ok: true,
    status: "succeeded",
    stoppedAt: null,
    blockers: [],
    rowApply,
    objectRestore,
    auditContinuity,
  };
}

function preflightBlockers(
  input: ExecuteTenantImportPreparedPlanInput,
): TenantImportExecutionBlocker[] {
  const blockers: TenantImportExecutionBlocker[] = [];
  if (input.confirmation !== tenantImportExecutionConfirmation) {
    blockers.push({
      stage: "preflight",
      code: "confirmation_required",
      message: "Tenant import execution requires an explicit internal confirmation token.",
    });
  }
  if (!input.plan.ok) {
    blockers.push({
      stage: "preflight",
      code: "plan_not_ok",
      message: "Tenant import execution requires a successful import plan.",
    });
  }
  if (input.objectRestorePlan.summary.blocked > 0) {
    blockers.push({
      stage: "preflight",
      code: "object_restore_plan_blocked",
      message: "Tenant import execution requires an object restore plan without blockers.",
    });
  }
  if (
    input.selfFetchDownloader === undefined &&
    input.objectRestorePlan.operations.some((operation) => operation.source === "self_fetch")
  ) {
    blockers.push({
      stage: "preflight",
      code: "self_fetch_downloader_required",
      message: "Tenant import execution requires a self-fetch downloader for self-fetch objects.",
    });
  }
  if (input.auditContinuityPlan.blockers.length > 0) {
    blockers.push({
      stage: "preflight",
      code: "audit_continuity_plan_blocked",
      message: "Tenant import execution requires an audit continuity plan without blockers.",
    });
  }
  return blockers;
}

async function appendAuditContinuityMarker(input: {
  readonly plan: TenantImportAuditContinuityPlan;
  readonly auditSink: AdminConsoleAuditSink;
  readonly actorId: string;
  readonly rowApplySummary: JsonObject;
  readonly objectRestoreSummary: JsonObject;
}): Promise<TenantImportExecutionAuditContinuityResult> {
  const result = await input.auditSink.append({
    orgId: input.plan.target.orgId,
    actorId: input.actorId,
    verb: input.plan.marker.verb,
    objectType: input.plan.marker.objectType,
    objectId: input.plan.marker.objectId,
    metadata: {
      ...input.plan.marker.metadata,
      rowApplySummary: input.rowApplySummary,
      objectRestoreSummary: input.objectRestoreSummary,
    },
  });
  return {
    ok: true,
    markerAuditId: result.id,
    markerHash: result.thisHash,
  };
}

function failed(
  stoppedAt: TenantImportExecutionStage,
  blockers: readonly TenantImportExecutionBlocker[],
): TenantImportExecutionResult {
  return {
    ok: false,
    status: "failed",
    stoppedAt,
    blockers,
    rowApply: null,
    objectRestore: null,
    auditContinuity: null,
  };
}

function blocked(
  stoppedAt: TenantImportExecutionStage,
  blockers: readonly TenantImportExecutionBlocker[],
): TenantImportExecutionResult {
  return {
    ok: false,
    status: "blocked",
    stoppedAt,
    blockers,
    rowApply: null,
    objectRestore: null,
    auditContinuity: null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Tenant import execution failed.";
}
