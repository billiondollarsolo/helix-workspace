import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import type { TenantExportAuditSummary, TenantExportManifest } from "./export.js";

export interface TenantImportAuditContinuitySource {
  readonly orgId: string;
  readonly slug: string;
  readonly generatedAt: string;
  readonly auditLog: TenantExportAuditSummary;
}

export interface TenantImportAuditChainHead {
  readonly id: string;
  readonly createdAt: string;
  readonly thisHash: string;
}

export interface TenantImportAuditContinuityMarker {
  readonly verb: "tenant.import.audit_continuity.recorded";
  readonly objectType: "tenant";
  readonly objectId: string;
  readonly metadata: JsonObject;
}

export interface TenantImportAuditContinuityPlan {
  readonly mode: "summary_only";
  readonly replaySupported: false;
  readonly reason: "source_activity_rows_not_exported" | "source_activity_rows_unsupported";
  readonly source: TenantImportAuditContinuitySource;
  readonly target: {
    readonly orgId: string;
    readonly slug?: string | undefined;
    readonly chainHead: TenantImportAuditChainHead | null;
  };
  readonly marker: TenantImportAuditContinuityMarker;
  readonly blockers: readonly TenantImportAuditContinuityBlocker[];
}

export interface TenantImportAuditContinuityBlocker {
  readonly code: "source_activity_rows_unsupported";
  readonly table: "activity";
  readonly message: string;
}

export interface BuildTenantImportAuditContinuityPlanInput {
  readonly manifest: TenantExportManifest;
  readonly targetOrgId: string;
  readonly targetSlug?: string | undefined;
  readonly targetChainHead?: TenantImportAuditChainHead | null | undefined;
  readonly importJobId?: string | undefined;
  readonly archiveSha256?: string | undefined;
}

export interface TenantImportAuditContinuityStore {
  getLatestAuditChainHead(orgId: string): Promise<TenantImportAuditChainHead | null>;
}

interface TargetAuditChainHeadRow {
  readonly id: string;
  readonly created_at: Date;
  readonly this_hash: string;
}

export class PostgresTenantImportAuditContinuityStore implements TenantImportAuditContinuityStore {
  constructor(private readonly sql: postgres.Sql) {}

  async getLatestAuditChainHead(orgId: string): Promise<TenantImportAuditChainHead | null> {
    const rows = (await this.sql`
      select id, created_at, this_hash
      from activity
      where org_id = ${orgId}
      order by created_at desc, id desc
      limit 1
    `) as unknown as readonly TargetAuditChainHeadRow[];
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      id: row.id,
      createdAt: row.created_at.toISOString(),
      thisHash: row.this_hash,
    };
  }
}

export function buildTenantImportAuditContinuityPlan(
  input: BuildTenantImportAuditContinuityPlanInput,
): TenantImportAuditContinuityPlan {
  const unsupportedActivityChunk = input.manifest.postgres.rowDataChunks.chunks.some(
    (chunk) => chunk.table === "activity",
  );
  const blockers: TenantImportAuditContinuityBlocker[] = unsupportedActivityChunk
    ? [
        {
          code: "source_activity_rows_unsupported",
          table: "activity",
          message:
            "Tenant import does not yet define a redacted, versioned activity-row replay schema.",
        },
      ]
    : [];
  const source: TenantImportAuditContinuitySource = {
    orgId: input.manifest.org.id,
    slug: input.manifest.org.slug,
    generatedAt: input.manifest.generatedAt,
    auditLog: input.manifest.auditLog,
  };
  return {
    mode: "summary_only",
    replaySupported: false,
    reason: unsupportedActivityChunk
      ? "source_activity_rows_unsupported"
      : "source_activity_rows_not_exported",
    source,
    target: {
      orgId: input.targetOrgId,
      ...(input.targetSlug === undefined ? {} : { slug: input.targetSlug }),
      chainHead: input.targetChainHead ?? null,
    },
    marker: {
      verb: "tenant.import.audit_continuity.recorded",
      objectType: "tenant",
      objectId: input.targetOrgId,
      metadata: continuityMetadata({
        source,
        targetOrgId: input.targetOrgId,
        targetSlug: input.targetSlug,
        targetChainHead: input.targetChainHead ?? null,
        importJobId: input.importJobId,
        archiveSha256: input.archiveSha256,
        unsupportedActivityChunk,
      }),
    },
    blockers,
  };
}

function continuityMetadata(input: {
  readonly source: TenantImportAuditContinuitySource;
  readonly targetOrgId: string;
  readonly targetSlug?: string | undefined;
  readonly targetChainHead: TenantImportAuditChainHead | null;
  readonly importJobId?: string | undefined;
  readonly archiveSha256?: string | undefined;
  readonly unsupportedActivityChunk: boolean;
}): JsonObject {
  return {
    mode: "summary_only",
    replaySupported: false,
    reason: input.unsupportedActivityChunk
      ? "source_activity_rows_unsupported"
      : "source_activity_rows_not_exported",
    sourceOrgId: input.source.orgId,
    sourceSlug: input.source.slug,
    sourceGeneratedAt: input.source.generatedAt,
    sourceAuditRowCount: input.source.auditLog.rowCount,
    sourceFirstEntryAt: input.source.auditLog.firstEntryAt,
    sourceLastEntryAt: input.source.auditLog.lastEntryAt,
    targetOrgId: input.targetOrgId,
    ...(input.targetSlug === undefined ? {} : { targetSlug: input.targetSlug }),
    targetPreImportChainHead: input.targetChainHead as unknown as JsonObject | null,
    ...(input.importJobId === undefined ? {} : { importJobId: input.importJobId }),
    ...(input.archiveSha256 === undefined ? {} : { archiveSha256: input.archiveSha256 }),
  };
}
