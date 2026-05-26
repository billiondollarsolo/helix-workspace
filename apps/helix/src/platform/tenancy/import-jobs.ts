import type postgres from "postgres";
import type {
  TenantImportDryRunConflictPolicy,
  TenantImportPlanObjectBytesMode,
} from "./import-plan.js";

export type TenantImportJobStatus = "succeeded" | "failed" | "blocked";

export interface TenantImportJobRemapInputSummary {
  readonly principalCount: number;
  readonly resourceCount: number;
  readonly sha256: string | null;
}

export interface TenantImportJobResultSummary {
  readonly ok: boolean;
  readonly archiveIssues: readonly TenantImportJobIssueSummary[];
  readonly plan: TenantImportJobPlanSummary | null;
  readonly execution?: TenantImportJobExecutionSummary | null | undefined;
}

export interface TenantImportJobExecutionSummary {
  readonly status: TenantImportJobStatus;
  readonly stoppedAt: string | null;
  readonly blockers: readonly {
    readonly stage: string;
    readonly code: string;
    readonly message: string;
  }[];
  readonly rowApply: Record<string, unknown> | null;
  readonly objectRestore: Record<string, unknown> | null;
  readonly auditContinuity: Record<string, unknown> | null;
}

export interface TenantImportJobIssueSummary {
  readonly severity: string;
  readonly code: string;
  readonly message: string;
  readonly path?: string | undefined;
  readonly table?: string | undefined;
  readonly field?: string | undefined;
  readonly sourceId?: string | undefined;
}

export interface TenantImportJobPlanSummary {
  readonly source: {
    readonly orgId: string;
    readonly slug: string;
    readonly generatedAt: string;
  };
  readonly target: {
    readonly orgId: string;
    readonly slug?: string | undefined;
    readonly rewritesOrgId: boolean;
  };
  readonly objectBytes: {
    readonly mode: TenantImportPlanObjectBytesMode;
    readonly objectCount: number;
    readonly totalKnownBytes: number;
  };
  readonly summary: {
    readonly postgresRows: number;
    readonly adminDomainRows: number;
    readonly adminDnsRecordRows: number;
    readonly resourceClassificationRows: number;
    readonly operationCount: number;
    readonly remapCount: number;
    readonly conflictCount: number;
  };
  readonly issueCount: number;
  readonly issues: readonly TenantImportJobIssueSummary[];
  readonly conflictCount: number;
  readonly conflicts: readonly TenantImportJobConflictSummary[];
}

export interface TenantImportJobConflictSummary {
  readonly severity: string;
  readonly code: string;
  readonly table: string;
  readonly sourceId?: string | undefined;
  readonly targetId?: string | undefined;
  readonly naturalKey?: readonly string[] | undefined;
  readonly field?: string | undefined;
}

export interface TenantImportJobRecord {
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
  readonly sourceGeneratedAt: Date | null;
  readonly objectBytesMode: TenantImportPlanObjectBytesMode | null;
  readonly issueCount: number;
  readonly operationCount: number;
  readonly conflictCount: number;
  readonly remapCount: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly resultSummary: TenantImportJobResultSummary;
  readonly completedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateTenantImportJobInput {
  readonly orgId: string;
  readonly status?: TenantImportJobStatus | undefined;
  readonly dryRun?: boolean | undefined;
  readonly requestedByActorId?: string | null | undefined;
  readonly archiveByteSize: number;
  readonly archiveSha256: string;
  readonly hasConflictPolicyInput: boolean;
  readonly conflictPolicy: TenantImportDryRunConflictPolicy;
  readonly hasRemapInput?: boolean | undefined;
  readonly remapInputSummary?: TenantImportJobRemapInputSummary | undefined;
  readonly ok: boolean;
  readonly sourceOrgId?: string | null | undefined;
  readonly sourceSlug?: string | null | undefined;
  readonly sourceGeneratedAt?: Date | null | undefined;
  readonly objectBytesMode?: TenantImportPlanObjectBytesMode | null | undefined;
  readonly issueCount: number;
  readonly operationCount: number;
  readonly conflictCount: number;
  readonly remapCount: number;
  readonly errorCode?: string | null | undefined;
  readonly errorMessage?: string | null | undefined;
  readonly resultSummary: TenantImportJobResultSummary;
}

export interface ListTenantImportJobsInput {
  readonly orgId: string;
  readonly limit?: number | undefined;
  readonly cursor?:
    | {
        readonly createdAt: Date;
        readonly id: string;
      }
    | undefined;
  readonly status?: TenantImportJobStatus | undefined;
}

export interface TenantImportJobStore {
  create(input: CreateTenantImportJobInput): Promise<TenantImportJobRecord>;
  findByIdForOrg(input: {
    readonly id: string;
    readonly orgId: string;
  }): Promise<TenantImportJobRecord | null>;
  listForOrg(input: ListTenantImportJobsInput): Promise<readonly TenantImportJobRecord[]>;
}

interface TenantImportJobRow {
  readonly id: string;
  readonly org_id: string;
  readonly status: TenantImportJobStatus;
  readonly dry_run: boolean;
  readonly requested_by_actor_id: string | null;
  readonly archive_byte_size: number | string;
  readonly archive_sha256: string;
  readonly has_conflict_policy_input: boolean;
  readonly conflict_policy: unknown;
  readonly has_remap_input: boolean;
  readonly remap_input_summary: unknown;
  readonly ok: boolean;
  readonly source_org_id: string | null;
  readonly source_slug: string | null;
  readonly source_generated_at: Date | null;
  readonly object_bytes_mode: TenantImportPlanObjectBytesMode | null;
  readonly issue_count: number | string;
  readonly operation_count: number | string;
  readonly conflict_count: number | string;
  readonly remap_count: number | string;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly result_summary: unknown;
  readonly completed_at: Date;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export class PostgresTenantImportJobStore implements TenantImportJobStore {
  constructor(private readonly sql: postgres.Sql) {}

  async create(input: CreateTenantImportJobInput): Promise<TenantImportJobRecord> {
    const rows = (await this.sql`
      insert into tenant_import_jobs (
        org_id,
        status,
        dry_run,
        requested_by_actor_id,
        archive_byte_size,
        archive_sha256,
        has_conflict_policy_input,
        conflict_policy,
        has_remap_input,
        remap_input_summary,
        ok,
        source_org_id,
        source_slug,
        source_generated_at,
        object_bytes_mode,
        issue_count,
        operation_count,
        conflict_count,
        remap_count,
        error_code,
        error_message,
        result_summary
      )
      values (
        ${input.orgId},
        ${input.status ?? "succeeded"},
        ${input.dryRun ?? true},
        ${input.requestedByActorId ?? null},
        ${input.archiveByteSize},
        ${input.archiveSha256},
        ${input.hasConflictPolicyInput},
        ${this.sql.json(sqlJson(input.conflictPolicy))},
        ${input.hasRemapInput ?? false},
        ${this.sql.json(sqlJson(input.remapInputSummary ?? emptyRemapInputSummary()))},
        ${input.ok},
        ${input.sourceOrgId ?? null},
        ${input.sourceSlug ?? null},
        ${input.sourceGeneratedAt ?? null},
        ${input.objectBytesMode ?? null},
        ${input.issueCount},
        ${input.operationCount},
        ${input.conflictCount},
        ${input.remapCount},
        ${input.errorCode ?? null},
        ${input.errorMessage ?? null},
        ${this.sql.json(sqlJson(input.resultSummary))}
      )
      returning
        id,
        org_id,
        status,
        dry_run,
        requested_by_actor_id,
        archive_byte_size,
        archive_sha256,
        has_conflict_policy_input,
        conflict_policy,
        has_remap_input,
        remap_input_summary,
        ok,
        source_org_id,
        source_slug,
        source_generated_at,
        object_bytes_mode,
        issue_count,
        operation_count,
        conflict_count,
        remap_count,
        error_code,
        error_message,
        result_summary,
        completed_at,
        created_at,
        updated_at
    `) as unknown as readonly TenantImportJobRow[];
    return mapTenantImportJobRow(rows[0]);
  }

  async findByIdForOrg(input: {
    readonly id: string;
    readonly orgId: string;
  }): Promise<TenantImportJobRecord | null> {
    const rows = (await this.sql`
      select
        id,
        org_id,
        status,
        dry_run,
        requested_by_actor_id,
        archive_byte_size,
        archive_sha256,
        has_conflict_policy_input,
        conflict_policy,
        has_remap_input,
        remap_input_summary,
        ok,
        source_org_id,
        source_slug,
        source_generated_at,
        object_bytes_mode,
        issue_count,
        operation_count,
        conflict_count,
        remap_count,
        error_code,
        error_message,
        result_summary,
        completed_at,
        created_at,
        updated_at
      from tenant_import_jobs
      where id = ${input.id}
        and org_id = ${input.orgId}
      limit 1
    `) as unknown as readonly TenantImportJobRow[];
    return rows[0] === undefined ? null : mapTenantImportJobRow(rows[0]);
  }

  async listForOrg(input: ListTenantImportJobsInput): Promise<readonly TenantImportJobRecord[]> {
    const cursorCreatedAt = input.cursor?.createdAt ?? null;
    const cursorId = input.cursor?.id ?? null;
    const status = input.status ?? null;
    const rows = (await this.sql`
      select
        id,
        org_id,
        status,
        dry_run,
        requested_by_actor_id,
        archive_byte_size,
        archive_sha256,
        has_conflict_policy_input,
        conflict_policy,
        has_remap_input,
        remap_input_summary,
        ok,
        source_org_id,
        source_slug,
        source_generated_at,
        object_bytes_mode,
        issue_count,
        operation_count,
        conflict_count,
        remap_count,
        error_code,
        error_message,
        result_summary,
        completed_at,
        created_at,
        updated_at
      from tenant_import_jobs
      where org_id = ${input.orgId}
        and (
          ${cursorCreatedAt}::timestamptz is null
          or (created_at, id) < (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
        )
        and (${status}::text is null or status = ${status})
      order by created_at desc, id desc
      limit ${boundedImportJobHistoryLimit(input.limit)}
    `) as unknown as readonly TenantImportJobRow[];
    return rows.map(mapTenantImportJobRow);
  }
}

export function mapTenantImportJobRow(row: TenantImportJobRow | undefined): TenantImportJobRecord {
  if (row === undefined) {
    throw new Error("Tenant import job query did not return a row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    status: row.status,
    dryRun: row.dry_run,
    requestedByActorId: row.requested_by_actor_id,
    archiveByteSize: Number(row.archive_byte_size),
    archiveSha256: row.archive_sha256,
    hasConflictPolicyInput: row.has_conflict_policy_input,
    conflictPolicy: importJobConflictPolicy(row.conflict_policy),
    hasRemapInput: row.has_remap_input,
    remapInputSummary: importJobRemapInputSummary(row.remap_input_summary),
    ok: row.ok,
    sourceOrgId: row.source_org_id,
    sourceSlug: row.source_slug,
    sourceGeneratedAt: row.source_generated_at,
    objectBytesMode: row.object_bytes_mode,
    issueCount: Number(row.issue_count),
    operationCount: Number(row.operation_count),
    conflictCount: Number(row.conflict_count),
    remapCount: Number(row.remap_count),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    resultSummary: importJobResultSummary(row.result_summary),
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function importJobConflictPolicy(value: unknown): TenantImportDryRunConflictPolicy {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function importJobRemapInputSummary(value: unknown): TenantImportJobRemapInputSummary {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as TenantImportJobRemapInputSummary;
  }
  return emptyRemapInputSummary();
}

function importJobResultSummary(value: unknown): TenantImportJobResultSummary {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as TenantImportJobResultSummary;
  }
  return { ok: false, archiveIssues: [], plan: null };
}

function sqlJson(value: unknown): postgres.JSONValue {
  return value as postgres.JSONValue;
}

function emptyRemapInputSummary(): TenantImportJobRemapInputSummary {
  return { principalCount: 0, resourceCount: 0, sha256: null };
}

function boundedImportJobHistoryLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 50;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}
