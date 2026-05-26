import { createHash } from "node:crypto";
import type postgres from "postgres";
import { trace } from "@opentelemetry/api";
import type { JsonObject, StorageObject } from "@helix/sdk-types";
import { withJobSpan } from "../observability/job-span.js";
import { setSpanTenantAttributes } from "../observability/tenant-span.js";
import {
  listTenantStorageMigrationObjects,
  type TenantStorageMigrationObject,
} from "../storage/migration.js";
import type { TenantStorageResolver } from "../storage/tenant-resolver.js";
import type { OrgRecord, OrgStore } from "./orgs.js";

export const tenantExportManifestVersion = 1;

export interface TenantExportTableCount {
  readonly table: string;
  readonly rowCount: number;
}

export type TenantExportPostgresDataChunkFormat = "jsonl";

export type TenantExportPostgresDataChunkExclusionReason =
  | "content_body"
  | "credential_material"
  | "customer_secret"
  | "token_material"
  | "webhook_payload";

export interface TenantExportPostgresDataChunk {
  readonly table: string;
  readonly path: string;
  readonly rowCount: number;
  readonly byteSize: number;
  readonly sha256: string;
  readonly orderBy: readonly string[];
}

export interface TenantExportPostgresDataChunkExclusion {
  readonly table: string;
  readonly reason: TenantExportPostgresDataChunkExclusionReason;
  readonly detail: string;
}

export interface TenantExportPostgresDataChunkManifest {
  readonly version: 1;
  readonly format: TenantExportPostgresDataChunkFormat;
  readonly chunks: readonly TenantExportPostgresDataChunk[];
  readonly includedTables: readonly string[];
  readonly excludedTables: readonly TenantExportPostgresDataChunkExclusion[];
  readonly notes: readonly string[];
}

export interface TenantExportPostgresDataChunkFile {
  readonly metadata: TenantExportPostgresDataChunk;
  readonly body: Uint8Array;
}

export interface TenantExportAuditSummary {
  readonly rowCount: number;
  readonly firstEntryAt: string | null;
  readonly lastEntryAt: string | null;
}

export interface TenantExportManifest {
  readonly version: 1;
  readonly generatedAt: string;
  readonly org: {
    readonly id: string;
    readonly slug: string;
    readonly displayName: string;
    readonly status: string;
    readonly tier: string;
    readonly planId: string;
    readonly region: string;
  };
  readonly configSnapshot: {
    readonly byoConfig: JsonObject;
    readonly featureFlags: JsonObject;
    readonly quotas: JsonObject;
    readonly branding: JsonObject;
  };
  readonly objectInventory: {
    readonly bytesIncluded: boolean;
    readonly objectCount: number;
    readonly totalKnownBytes: number;
    readonly objects: readonly TenantStorageMigrationObject[];
  };
  readonly postgres: {
    readonly rowCounts: readonly TenantExportTableCount[];
    readonly rowDataChunks: TenantExportPostgresDataChunkManifest;
    readonly rowDataChunkFiles?: readonly TenantExportPostgresDataChunkFile[] | undefined;
  };
  readonly auditLog: TenantExportAuditSummary;
}

export interface TenantExportArchive {
  readonly filename: string;
  readonly contentType: "application/x-tar";
  readonly byteSize: number;
  readonly bytes: Buffer;
}

export interface TenantExportArchiveStream {
  readonly filename: string;
  readonly contentType: "application/x-tar";
  readonly byteSize: number;
  readonly body: AsyncIterable<Uint8Array>;
}

export interface TenantExportArchiveArtifact {
  readonly filename: string;
  readonly contentType: "application/x-tar";
  readonly byteSize: number;
  readonly storageKey: string;
  readonly downloadUrl: string;
  readonly expiresAt: string;
  readonly expiresSeconds: number;
}

export interface TenantExportSelfFetchObject {
  readonly storageKey: string;
  readonly byteSize?: number | undefined;
  readonly sha256?: string | undefined;
  readonly url: string;
  readonly expiresAt: string;
}

export interface TenantExportSelfFetchManifest {
  readonly version: 1;
  readonly generatedAt: string;
  readonly org: {
    readonly id: string;
    readonly slug: string;
  };
  readonly delivery: "self-fetch";
  readonly expiresAt: string;
  readonly expiresSeconds: number;
  readonly objects: readonly TenantExportSelfFetchObject[];
}

export type TenantExportObjectByteDelivery = "archive" | "self-fetch";

export interface BuildTenantExportManifestInput {
  readonly org: OrgRecord;
  readonly objects: readonly TenantStorageMigrationObject[];
  readonly rowCounts: readonly TenantExportTableCount[];
  readonly rowDataChunkFiles?: readonly TenantExportPostgresDataChunkFile[] | undefined;
  readonly auditSummary: TenantExportAuditSummary;
  readonly generatedAt?: Date | undefined;
  readonly bytesIncluded?: boolean | undefined;
}

export interface BuildTenantExportArchiveOptions {
  readonly includeObjectBytes?: boolean | undefined;
  readonly objectByteDelivery?: TenantExportObjectByteDelivery | undefined;
  readonly presignedUrlExpiresSeconds?: number | undefined;
  readonly storageResolver?: TenantStorageResolver | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface BuildTenantExportSelfFetchManifestOptions {
  readonly presignedUrlExpiresSeconds?: number | undefined;
  readonly storageResolver?: TenantStorageResolver | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface MaterializeTenantExportArchiveArtifactOptions extends BuildTenantExportArchiveOptions {
  readonly archiveStorageKey?: string | undefined;
}

export type TenantExportJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface TenantExportJobRecord {
  readonly id: string;
  readonly orgId: string;
  readonly status: TenantExportJobStatus;
  readonly includeObjectBytes: boolean;
  readonly presignedUrlExpiresSeconds: number;
  readonly requestedByActorId: string | null;
  readonly storageKey: string | null;
  readonly filename: string | null;
  readonly contentType: "application/x-tar" | null;
  readonly byteSize: number | null;
  readonly lastError: string | null;
  readonly attemptCount: number;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateTenantExportJobInput {
  readonly orgId: string;
  readonly includeObjectBytes?: boolean | undefined;
  readonly presignedUrlExpiresSeconds?: number | undefined;
  readonly requestedByActorId?: string | null | undefined;
}

export interface ListTenantExportJobsInput {
  readonly orgId: string;
  readonly limit?: number | undefined;
  readonly cursor?:
    | {
        readonly createdAt: Date;
        readonly id: string;
      }
    | undefined;
  readonly status?: TenantExportJobStatus | undefined;
}

export interface CompleteTenantExportJobInput {
  readonly id: string;
  readonly artifact: Pick<
    TenantExportArchiveArtifact,
    "byteSize" | "contentType" | "filename" | "storageKey"
  >;
}

export interface TenantExportJobStore {
  create(input: CreateTenantExportJobInput): Promise<TenantExportJobRecord>;
  findByIdForOrg(input: {
    readonly id: string;
    readonly orgId: string;
  }): Promise<TenantExportJobRecord | null>;
  listForOrg(input: ListTenantExportJobsInput): Promise<readonly TenantExportJobRecord[]>;
  claimPending(input?: {
    readonly limit?: number | undefined;
  }): Promise<readonly TenantExportJobRecord[]>;
  markCompleted(input: CompleteTenantExportJobInput): Promise<TenantExportJobRecord>;
  markFailed(input: {
    readonly id: string;
    readonly error: string;
  }): Promise<TenantExportJobRecord>;
  getObservabilitySnapshot(input: {
    readonly stalledBefore: Date;
    readonly now: Date;
  }): Promise<TenantExportJobObservabilitySnapshot>;
}

export interface TenantExportJobObservabilitySnapshot {
  readonly activeJobs: readonly {
    readonly status: "queued" | "running" | "failed";
    readonly count: number;
  }[];
  readonly stalledJobs: {
    readonly count: number;
    readonly oldestAgeSeconds: number;
  };
}

export interface TenantExportMetrics {
  recordTenantExportJob(input: {
    readonly status: "succeeded" | "failed";
    readonly objectBytes: "included" | "metadata_only";
  }): void;
  setTenantExportJobObservability(snapshot: TenantExportJobObservabilitySnapshot): void;
}

export interface TenantExportMaterializationWorkerOptions {
  readonly store: Pick<
    TenantExportJobStore,
    "claimPending" | "getObservabilitySnapshot" | "markCompleted" | "markFailed"
  >;
  readonly orgs: Pick<OrgStore, "findById">;
  readonly exportPlanner: TenantExportManifestPlanner;
  readonly storageResolver: TenantStorageResolver;
  readonly intervalMs?: number | undefined;
  readonly batchSize?: number | undefined;
  readonly stalledAfterMs?: number | undefined;
  readonly metrics?: TenantExportMetrics | undefined;
  readonly now?: (() => Date) | undefined;
  readonly onResult?: (result: TenantExportMaterializationWorkerRunResult) => void;
  readonly onError?: (error: unknown) => void;
}

export interface TenantExportMaterializationWorkerRunResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
}

export type TenantExportManifestPlanner = (
  org: OrgRecord,
) => Promise<TenantExportManifest> | TenantExportManifest;

interface TenantExportTableCountRow {
  readonly table_name: string;
  readonly row_count: number;
}

interface TenantExportAuditSummaryRow {
  readonly row_count: number;
  readonly first_entry_at: Date | null;
  readonly last_entry_at: Date | null;
}

interface TenantExportAdminDomainRow {
  readonly id: string;
  readonly org_id: string;
  readonly domain: string;
  readonly is_primary: boolean;
  readonly verification_status: string;
  readonly verified_at: Date | null;
  readonly created_by: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface TenantExportAdminDnsRecordRow {
  readonly id: string;
  readonly org_id: string;
  readonly domain_id: string;
  readonly record_type: string;
  readonly host: string;
  readonly expected_value: string;
  readonly observed_value: string | null;
  readonly status: string;
  readonly last_checked_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface TenantExportJobRow {
  readonly id: string;
  readonly org_id: string;
  readonly status: TenantExportJobStatus;
  readonly include_object_bytes: boolean;
  readonly presigned_url_expires_seconds: number;
  readonly requested_by_actor_id: string | null;
  readonly storage_key: string | null;
  readonly filename: string | null;
  readonly content_type: string | null;
  readonly byte_size: number | string | null;
  readonly last_error: string | null;
  readonly attempt_count: number;
  readonly started_at: Date | null;
  readonly completed_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface TenantExportJobActiveCountRow {
  readonly status: "queued" | "running" | "failed";
  readonly count: number | string;
}

interface TenantExportJobStalledCountRow {
  readonly count: number | string;
  readonly oldest_age_seconds: number | string | null;
}

export function createPostgresTenantExportManifestPlanner(
  sql: postgres.Sql,
): TenantExportManifestPlanner {
  return async (org) =>
    buildTenantExportManifest({
      org,
      objects: await listTenantStorageMigrationObjects(sql, org.id),
      rowCounts: await countTenantExportRows(sql, org.id),
      rowDataChunkFiles: await buildTenantExportPostgresDataChunkFiles(sql, org.id),
      auditSummary: await summarizeTenantExportAudit(sql, org.id),
    });
}

export function buildTenantExportManifest(
  input: BuildTenantExportManifestInput,
): TenantExportManifest {
  const totalKnownBytes = input.objects.reduce(
    (total, object) => total + (object.byteSize ?? 0),
    0,
  );
  return {
    version: tenantExportManifestVersion,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    org: {
      id: input.org.id,
      slug: input.org.slug,
      displayName: input.org.displayName,
      status: input.org.status,
      tier: input.org.tier,
      planId: input.org.planId,
      region: input.org.region,
    },
    configSnapshot: {
      byoConfig: input.org.byoConfig,
      featureFlags: input.org.featureFlags,
      quotas: input.org.quotas,
      branding: input.org.branding,
    },
    objectInventory: {
      bytesIncluded: input.bytesIncluded === true,
      objectCount: input.objects.length,
      totalKnownBytes,
      objects: input.objects,
    },
    postgres: {
      rowCounts: input.rowCounts,
      rowDataChunks: buildTenantExportPostgresDataChunkManifest(input.rowDataChunkFiles ?? []),
      ...(input.rowDataChunkFiles === undefined
        ? {}
        : { rowDataChunkFiles: input.rowDataChunkFiles }),
    },
    auditLog: input.auditSummary,
  };
}

export async function buildTenantExportArchive(
  manifest: TenantExportManifest,
  options: BuildTenantExportArchiveOptions = {},
): Promise<TenantExportArchive> {
  const files = await tenantExportArchiveFiles(manifest, options);
  const bytes = buildTarArchive(
    await Promise.all(
      files.map(async (file) => ({
        path: file.path,
        body: await archiveFileBodyBytes(file.body),
      })),
    ),
    Math.floor(Date.parse(manifest.generatedAt) / 1000),
  );
  return {
    filename: `helix-export-${manifest.org.slug}-${archiveTimestamp(manifest.generatedAt)}.tar`,
    contentType: "application/x-tar",
    byteSize: bytes.byteLength,
    bytes,
  };
}

export async function streamTenantExportArchive(
  manifest: TenantExportManifest,
  options: BuildTenantExportArchiveOptions = {},
): Promise<TenantExportArchiveStream> {
  const files = await tenantExportArchiveFiles(manifest, options);
  return {
    filename: `helix-export-${manifest.org.slug}-${archiveTimestamp(manifest.generatedAt)}.tar`,
    contentType: "application/x-tar",
    byteSize: tarArchiveByteSize(files),
    body: streamTarArchive(files, Math.floor(Date.parse(manifest.generatedAt) / 1000)),
  };
}

export async function materializeTenantExportArchiveArtifact(
  manifest: TenantExportManifest,
  options: MaterializeTenantExportArchiveArtifactOptions,
): Promise<TenantExportArchiveArtifact> {
  if (options.storageResolver === undefined) {
    throw new Error("Tenant storage resolver is required to materialize export archives.");
  }
  const storage = await options.storageResolver({ orgId: manifest.org.id });
  if (storage === undefined) {
    throw new Error("Tenant storage resolver did not resolve storage for tenant export.");
  }
  if (storage.client.presignGetUrl === undefined) {
    throw new Error("Tenant export storage does not support presigned archive fetch.");
  }
  const archive = await streamTenantExportArchive(manifest, options);
  const storageKey =
    options.archiveStorageKey ?? defaultArchiveArtifactStorageKey(manifest, archive.filename);
  const expiresSeconds = validatePresignedUrlExpiresSeconds(
    options.presignedUrlExpiresSeconds ?? 3600,
  );
  const now = options.now ?? (() => new Date());
  const expiresAt = new Date(now().getTime() + expiresSeconds * 1000).toISOString();

  await storage.client.put({
    key: storageKey,
    body: archive.body,
    contentType: archive.contentType,
    metadata: {
      "helix-org-id": manifest.org.id,
      "helix-export-generated-at": manifest.generatedAt,
      "helix-export-filename": archive.filename,
    },
  });

  return {
    filename: archive.filename,
    contentType: archive.contentType,
    byteSize: archive.byteSize,
    storageKey,
    downloadUrl: await storage.client.presignGetUrl(storageKey, { expiresSeconds }),
    expiresAt,
    expiresSeconds,
  };
}

export async function presignTenantExportJobArtifact(
  job: TenantExportJobRecord,
  options: {
    readonly storageResolver: TenantStorageResolver | undefined;
    readonly now?: (() => Date) | undefined;
  },
): Promise<TenantExportArchiveArtifact | undefined> {
  if (
    job.status !== "succeeded" ||
    job.storageKey === null ||
    job.filename === null ||
    job.contentType === null ||
    job.byteSize === null
  ) {
    return undefined;
  }
  if (options.storageResolver === undefined) {
    throw new Error("Tenant storage resolver is required to presign export archive artifacts.");
  }
  const storage = await options.storageResolver({ orgId: job.orgId });
  if (storage === undefined) {
    throw new Error("Tenant storage resolver did not resolve storage for tenant export.");
  }
  if (storage.client.presignGetUrl === undefined) {
    throw new Error("Tenant export storage does not support presigned archive fetch.");
  }
  const now = options.now ?? (() => new Date());
  const expiresAt = new Date(now().getTime() + job.presignedUrlExpiresSeconds * 1000).toISOString();
  return {
    filename: job.filename,
    contentType: job.contentType,
    byteSize: job.byteSize,
    storageKey: job.storageKey,
    downloadUrl: await storage.client.presignGetUrl(job.storageKey, {
      expiresSeconds: job.presignedUrlExpiresSeconds,
    }),
    expiresAt,
    expiresSeconds: job.presignedUrlExpiresSeconds,
  };
}

export class PostgresTenantExportJobStore implements TenantExportJobStore {
  constructor(private readonly sql: postgres.Sql) {}

  async create(input: CreateTenantExportJobInput): Promise<TenantExportJobRecord> {
    const rows = (await this.sql`
      insert into tenant_export_jobs (
        org_id,
        include_object_bytes,
        presigned_url_expires_seconds,
        requested_by_actor_id
      )
      values (
        ${input.orgId},
        ${input.includeObjectBytes ?? true},
        ${validatePresignedUrlExpiresSeconds(input.presignedUrlExpiresSeconds ?? 86_400)},
        ${input.requestedByActorId ?? null}
      )
      returning
        id,
        org_id,
        status,
        include_object_bytes,
        presigned_url_expires_seconds,
        requested_by_actor_id,
        storage_key,
        filename,
        content_type,
        byte_size,
        last_error,
        attempt_count,
        started_at,
        completed_at,
        created_at,
        updated_at
    `) as unknown as readonly TenantExportJobRow[];
    return mapTenantExportJobRow(rows[0]);
  }

  async findByIdForOrg(input: {
    readonly id: string;
    readonly orgId: string;
  }): Promise<TenantExportJobRecord | null> {
    const rows = (await this.sql`
      select
        id,
        org_id,
        status,
        include_object_bytes,
        presigned_url_expires_seconds,
        requested_by_actor_id,
        storage_key,
        filename,
        content_type,
        byte_size,
        last_error,
        attempt_count,
        started_at,
        completed_at,
        created_at,
        updated_at
      from tenant_export_jobs
      where id = ${input.id}
        and org_id = ${input.orgId}
      limit 1
    `) as unknown as readonly TenantExportJobRow[];
    return rows[0] === undefined ? null : mapTenantExportJobRow(rows[0]);
  }

  async listForOrg(input: ListTenantExportJobsInput): Promise<readonly TenantExportJobRecord[]> {
    const cursorCreatedAt = input.cursor?.createdAt ?? null;
    const cursorId = input.cursor?.id ?? null;
    const status = input.status ?? null;
    const rows = (await this.sql`
      select
        id,
        org_id,
        status,
        include_object_bytes,
        presigned_url_expires_seconds,
        requested_by_actor_id,
        storage_key,
        filename,
        content_type,
        byte_size,
        last_error,
        attempt_count,
        started_at,
        completed_at,
        created_at,
        updated_at
      from tenant_export_jobs
      where org_id = ${input.orgId}
        and (
          ${cursorCreatedAt}::timestamptz is null
          or (created_at, id) < (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
        )
        and (${status}::text is null or status = ${status})
      order by created_at desc, id desc
      limit ${boundedExportJobHistoryLimit(input.limit)}
    `) as unknown as readonly TenantExportJobRow[];
    return rows.map(mapTenantExportJobRow);
  }

  async claimPending(
    input: { readonly limit?: number | undefined } = {},
  ): Promise<readonly TenantExportJobRecord[]> {
    const rows = (await this.sql`
      update tenant_export_jobs
      set
        status = 'running',
        attempt_count = attempt_count + 1,
        last_error = null,
        started_at = coalesce(started_at, now()),
        updated_at = now()
      where id in (
        select id
        from tenant_export_jobs
        where status in ('queued', 'failed')
        order by updated_at asc
        limit ${input.limit ?? 2}
        for update skip locked
      )
      returning
        id,
        org_id,
        status,
        include_object_bytes,
        presigned_url_expires_seconds,
        requested_by_actor_id,
        storage_key,
        filename,
        content_type,
        byte_size,
        last_error,
        attempt_count,
        started_at,
        completed_at,
        created_at,
        updated_at
    `) as unknown as readonly TenantExportJobRow[];
    return rows.map(mapTenantExportJobRow);
  }

  async markCompleted(input: CompleteTenantExportJobInput): Promise<TenantExportJobRecord> {
    const rows = (await this.sql`
      update tenant_export_jobs
      set
        status = 'succeeded',
        storage_key = ${input.artifact.storageKey},
        filename = ${input.artifact.filename},
        content_type = ${input.artifact.contentType},
        byte_size = ${input.artifact.byteSize},
        last_error = null,
        completed_at = now(),
        updated_at = now()
      where id = ${input.id}
      returning
        id,
        org_id,
        status,
        include_object_bytes,
        presigned_url_expires_seconds,
        requested_by_actor_id,
        storage_key,
        filename,
        content_type,
        byte_size,
        last_error,
        attempt_count,
        started_at,
        completed_at,
        created_at,
        updated_at
    `) as unknown as readonly TenantExportJobRow[];
    return mapTenantExportJobRow(rows[0]);
  }

  async markFailed(input: {
    readonly id: string;
    readonly error: string;
  }): Promise<TenantExportJobRecord> {
    const rows = (await this.sql`
      update tenant_export_jobs
      set
        status = 'failed',
        last_error = ${input.error},
        completed_at = now(),
        updated_at = now()
      where id = ${input.id}
      returning
        id,
        org_id,
        status,
        include_object_bytes,
        presigned_url_expires_seconds,
        requested_by_actor_id,
        storage_key,
        filename,
        content_type,
        byte_size,
        last_error,
        attempt_count,
        started_at,
        completed_at,
        created_at,
        updated_at
    `) as unknown as readonly TenantExportJobRow[];
    return mapTenantExportJobRow(rows[0]);
  }

  async getObservabilitySnapshot(input: {
    readonly stalledBefore: Date;
    readonly now: Date;
  }): Promise<TenantExportJobObservabilitySnapshot> {
    const activeRows = (await this.sql`
      select status, count(*)::integer as count
      from tenant_export_jobs
      where status in ('queued', 'running', 'failed')
      group by status
    `) as unknown as readonly TenantExportJobActiveCountRow[];
    const stalledRows = (await this.sql`
      select
        count(*)::integer as count,
        floor(extract(epoch from (${input.now}::timestamptz - min(coalesce(started_at, updated_at, created_at)))))::integer as oldest_age_seconds
      from tenant_export_jobs
      where status = 'running'
        and coalesce(started_at, updated_at, created_at) <= ${input.stalledBefore}
    `) as unknown as readonly TenantExportJobStalledCountRow[];
    const stalled = stalledRows[0];

    return {
      activeJobs: activeRows.map((row) => ({
        status: row.status,
        count: Number(row.count),
      })),
      stalledJobs: {
        count: stalled === undefined ? 0 : Number(stalled.count),
        oldestAgeSeconds:
          stalled?.oldest_age_seconds === null || stalled?.oldest_age_seconds === undefined
            ? 0
            : Number(stalled.oldest_age_seconds),
      },
    };
  }
}

const defaultExportWorkerIntervalMs = 15_000;
const defaultExportWorkerBatchSize = 2;

export class TenantExportMaterializationWorker {
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly stalledAfterMs: number;
  private readonly metrics: TenantExportMetrics | undefined;
  private readonly now: () => Date;
  private readonly onResult:
    | ((result: TenantExportMaterializationWorkerRunResult) => void)
    | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<TenantExportMaterializationWorkerRunResult> | undefined;

  constructor(private readonly options: TenantExportMaterializationWorkerOptions) {
    this.intervalMs = options.intervalMs ?? defaultExportWorkerIntervalMs;
    this.batchSize = options.batchSize ?? defaultExportWorkerBatchSize;
    this.stalledAfterMs = options.stalledAfterMs ?? 30 * 60 * 1000;
    this.metrics = options.metrics;
    this.now = options.now ?? (() => new Date());
    this.onResult = options.onResult;
    this.onError = options.onError;
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    // eslint-disable-next-line helix/pacer-discipline -- Matches the existing leader-gated worker contract.
    this.timer = setInterval(() => {
      void this.runScheduledMaterialization();
    }, this.intervalMs);
    this.timer.unref();
    void this.runScheduledMaterialization();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      // eslint-disable-next-line helix/pacer-discipline -- Matches the existing leader-gated worker contract.
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.activeRun !== undefined) {
      await this.activeRun;
    }
  }

  async runOnce(): Promise<TenantExportMaterializationWorkerRunResult> {
    return withJobSpan("tenant-export-materialization", async () => {
      const jobs = await this.options.store.claimPending({ limit: this.batchSize });
      let succeeded = 0;
      let failed = 0;

      for (const job of jobs) {
        try {
          await withJobSpan("tenant-export-materialization.job", async () => {
            const span = trace.getActiveSpan();
            span?.setAttribute("helix.tenant_export.job_id", job.id);
            span?.setAttribute("helix.tenant_export.include_object_bytes", job.includeObjectBytes);
            span?.setAttribute("helix.tenant_export.attempt_count", job.attemptCount);

            try {
              const org = await this.options.orgs.findById(job.orgId);
              if (org === null) {
                throw new Error(`Tenant export job org is unavailable: ${job.orgId}`);
              }
              if (span !== undefined) {
                setSpanTenantAttributes(span, {
                  orgId: org.id,
                  orgSlug: org.slug,
                  orgTier: org.tier,
                  orgRegion: org.region,
                });
              }
              const manifest = await this.options.exportPlanner(org);
              const artifact = await materializeTenantExportArchiveArtifact(manifest, {
                includeObjectBytes: job.includeObjectBytes,
                objectByteDelivery: "archive",
                archiveStorageKey: tenantExportJobArtifactStorageKey(job),
                presignedUrlExpiresSeconds: job.presignedUrlExpiresSeconds,
                storageResolver: this.options.storageResolver,
                now: this.now,
              });
              const completed = await this.options.store.markCompleted({ id: job.id, artifact });
              span?.setAttribute("helix.tenant_export.status", completed.status);
              span?.setAttribute("helix.tenant_export.byte_size", completed.byteSize ?? 0);
              if (completed.status === "succeeded") {
                this.metrics?.recordTenantExportJob({
                  status: completed.status,
                  objectBytes: tenantExportObjectBytesLabel(completed.includeObjectBytes),
                });
              }
              succeeded += 1;
            } catch (error) {
              const failedJob = await this.options.store.markFailed({
                id: job.id,
                error: errorMessage(error),
              });
              span?.setAttribute("helix.tenant_export.status", failedJob.status);
              if (failedJob.status === "failed") {
                this.metrics?.recordTenantExportJob({
                  status: failedJob.status,
                  objectBytes: tenantExportObjectBytesLabel(failedJob.includeObjectBytes),
                });
              }
              throw error;
            }
          });
        } catch {
          failed += 1;
        }
      }

      await this.recordObservabilitySnapshot();
      return { claimed: jobs.length, succeeded, failed };
    });
  }

  private async recordObservabilitySnapshot(): Promise<void> {
    if (this.metrics === undefined) {
      return;
    }
    try {
      const now = this.now();
      const stalledBefore = new Date(now.getTime() - this.stalledAfterMs);
      const snapshot = await this.options.store.getObservabilitySnapshot({
        stalledBefore,
        now,
      });
      this.metrics.setTenantExportJobObservability(snapshot);
    } catch (error) {
      this.onError?.(error);
    }
  }

  private runScheduledMaterialization(): Promise<TenantExportMaterializationWorkerRunResult> {
    if (this.activeRun !== undefined) {
      return this.activeRun;
    }
    const activeRun = this.runOnce()
      .then((result) => {
        this.onResult?.(result);
        return result;
      })
      .catch((error: unknown) => {
        this.onError?.(error);
        return { claimed: 0, succeeded: 0, failed: 0 };
      })
      .finally(() => {
        this.activeRun = undefined;
      });
    this.activeRun = activeRun;
    return activeRun;
  }
}

function tenantExportObjectBytesLabel(includeObjectBytes: boolean): "included" | "metadata_only" {
  return includeObjectBytes ? "included" : "metadata_only";
}

function mapTenantExportJobRow(row: TenantExportJobRow | undefined): TenantExportJobRecord {
  if (row === undefined) {
    throw new Error("Tenant export job query returned no rows.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    status: row.status,
    includeObjectBytes: row.include_object_bytes,
    presignedUrlExpiresSeconds: row.presigned_url_expires_seconds,
    requestedByActorId: row.requested_by_actor_id,
    storageKey: row.storage_key,
    filename: row.filename,
    contentType:
      row.content_type === null ? null : contentTypeFromTenantExportJobRow(row.content_type),
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    lastError: row.last_error,
    attemptCount: row.attempt_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function contentTypeFromTenantExportJobRow(value: string): "application/x-tar" {
  if (value !== "application/x-tar") {
    throw new Error(`Unsupported tenant export job content type: ${value}`);
  }
  return value;
}

function tenantExportJobArtifactStorageKey(
  job: Pick<TenantExportJobRecord, "id" | "orgId">,
): string {
  return `tenant-exports/jobs/${job.orgId}/${job.id}/archive.tar`;
}

function boundedExportJobHistoryLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 50;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), 200);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function tenantExportArchiveFiles(
  manifest: TenantExportManifest,
  options: BuildTenantExportArchiveOptions,
): Promise<readonly TenantExportArchiveFile[]> {
  const objectByteDelivery = options.objectByteDelivery ?? "archive";
  const metadataManifest =
    options.includeObjectBytes === true && objectByteDelivery === "archive"
      ? {
          ...manifest,
          objectInventory: { ...manifest.objectInventory, bytesIncluded: true },
        }
      : manifest;
  const files: TenantExportArchiveFile[] = [
    {
      path: "manifest.json",
      body: stableJson({
        version: metadataManifest.version,
        generatedAt: metadataManifest.generatedAt,
        org: metadataManifest.org,
        objectInventory: {
          bytesIncluded: metadataManifest.objectInventory.bytesIncluded,
          objectCount: metadataManifest.objectInventory.objectCount,
          totalKnownBytes: metadataManifest.objectInventory.totalKnownBytes,
        },
        postgres: {
          rowCounts: metadataManifest.postgres.rowCounts,
          rowDataChunks: metadataManifest.postgres.rowDataChunks,
        },
        auditLog: metadataManifest.auditLog,
      }),
    },
    {
      path: "config-snapshot.json",
      body: stableJson(metadataManifest.configSnapshot),
    },
    {
      path: "objects/inventory.json",
      body: stableJson(metadataManifest.objectInventory),
    },
    {
      path: "postgres/schema.sql",
      body: textBytes(
        [
          "-- Helix tenant export v1 metadata archive.",
          "-- Apply the matching Helix migration set before importing future data chunks.",
          "",
        ].join("\n"),
      ),
    },
    {
      path: "postgres/data/row-counts.json",
      body: stableJson(metadataManifest.postgres.rowCounts),
    },
    {
      path: "postgres/data/chunks/manifest.json",
      body: stableJson(metadataManifest.postgres.rowDataChunks),
    },
    ...tenantExportPostgresDataChunkArchiveFiles(metadataManifest.postgres.rowDataChunkFiles ?? []),
    {
      path: "audit-log/summary.json",
      body: stableJson(metadataManifest.auditLog),
    },
    {
      path: "secrets-public.json",
      body: stableJson({
        oidcIssuerUrls: [],
        scimEndpoint: null,
        credentialsIncluded: false,
      }),
    },
    {
      path: "README.md",
      body: textBytes(exportReadme(metadataManifest)),
    },
  ];

  if (options.includeObjectBytes === true) {
    if (objectByteDelivery === "self-fetch") {
      files.push({
        path: "objects/self-fetch-manifest.json",
        body: stableJson(await buildTenantExportSelfFetchManifest(metadataManifest, options)),
      });
    } else {
      files.push(...(await objectByteArchiveFiles(metadataManifest, options.storageResolver)));
    }
  }

  return files;
}

export async function buildTenantExportPostgresDataChunkFiles(
  sql: postgres.Sql,
  orgId: string,
): Promise<readonly TenantExportPostgresDataChunkFile[]> {
  const adminDomains = (await sql`
    select id, org_id, domain, is_primary, verification_status, verified_at,
           created_by, created_at, updated_at
    from admin_domains
    where org_id = ${orgId}
    order by lower(domain) asc, created_at asc, id asc
  `) as unknown as readonly TenantExportAdminDomainRow[];
  const adminDnsRecords = (await sql`
    select id, org_id, domain_id, record_type, host, expected_value, observed_value,
           status, last_checked_at, created_at, updated_at
    from admin_dns_records
    where org_id = ${orgId}
    order by domain_id asc, record_type asc, host asc, id asc
  `) as unknown as readonly TenantExportAdminDnsRecordRow[];

  return [
    buildTenantExportPostgresDataChunkFile({
      table: "admin_domains",
      path: "postgres/data/chunks/admin_domains/000000.jsonl",
      orderBy: ["lower(domain)", "created_at", "id"],
      rows: adminDomains.map((row) => ({
        id: row.id,
        orgId: row.org_id,
        domain: row.domain,
        isPrimary: row.is_primary,
        verificationStatus: row.verification_status,
        verifiedAt: row.verified_at?.toISOString() ?? null,
        createdBy: row.created_by,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
    }),
    buildTenantExportPostgresDataChunkFile({
      table: "admin_dns_records",
      path: "postgres/data/chunks/admin_dns_records/000000.jsonl",
      orderBy: ["domain_id", "record_type", "host", "id"],
      rows: adminDnsRecords.map((row) => ({
        id: row.id,
        orgId: row.org_id,
        domainId: row.domain_id,
        recordType: row.record_type,
        host: row.host,
        expectedValue: row.expected_value,
        observedValue: row.observed_value,
        status: row.status,
        lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
    }),
  ];
}

export async function countTenantExportRows(
  sql: postgres.Sql,
  orgId: string,
): Promise<readonly TenantExportTableCount[]> {
  const rows = (await sql`
    select 'actors' as table_name, count(*)::integer as row_count from actors where org_id = ${orgId}
    union all select 'objects', count(*)::integer from objects where org_id = ${orgId}
    union all select 'threads', count(*)::integer from threads where org_id = ${orgId}
    union all select 'messages', count(*)::integer from messages where org_id = ${orgId}
    union all select 'message_attachments', count(*)::integer from message_attachments join messages on messages.id = message_attachments.message_id where messages.org_id = ${orgId}
    union all select 'permissions', count(*)::integer from permissions where org_id = ${orgId}
    union all select 'activity', count(*)::integer from activity where org_id = ${orgId}
    union all select 'admin_domains', count(*)::integer from admin_domains where org_id = ${orgId}
    union all select 'admin_dns_records', count(*)::integer from admin_dns_records where org_id = ${orgId}
    union all select 'tenant_config_audit', count(*)::integer from tenant_config_audit where org_id = ${orgId}
    union all select 'tenant_storage_migration_jobs', count(*)::integer from tenant_storage_migration_jobs where org_id = ${orgId}
    union all select 'ai_artifacts', count(*)::integer from ai_artifacts where org_id = ${orgId}
    union all select 'memory_items', count(*)::integer from memory_items where org_id = ${orgId}
    union all select 'pending_actions', count(*)::integer from pending_actions where org_id = ${orgId}
    union all select 'assistant_conversations', count(*)::integer from assistant_conversations where org_id = ${orgId}
    union all select 'assistant_messages', count(*)::integer from assistant_messages where org_id = ${orgId}
    union all select 'assistant_memory_preferences', count(*)::integer from assistant_memory_preferences where org_id = ${orgId}
    union all select 'app_passwords', count(*)::integer from app_passwords join actors on actors.id = app_passwords.actor_id where actors.org_id = ${orgId}
    union all select 'agent_credentials', count(*)::integer from agent_credentials join actors on actors.id = agent_credentials.actor_id where actors.org_id = ${orgId}
    union all select 'oauth_access_tokens', count(*)::integer from oauth_access_tokens where org_id = ${orgId}
    union all select 'oauth_authorization_codes', count(*)::integer from oauth_authorization_codes where org_id = ${orgId}
    union all select 'outbound_webhooks', count(*)::integer from outbound_webhooks where org_id = ${orgId}
    union all select 'inbound_webhooks', count(*)::integer from inbound_webhooks where org_id = ${orgId}
    union all select 'webhook_deliveries', count(*)::integer from webhook_deliveries where org_id = ${orgId}
    union all select 'mail_filters', count(*)::integer from mail_filters where org_id = ${orgId}
    union all select 'mail_aliases', count(*)::integer from mail_aliases where org_id = ${orgId}
    union all select 'mail_vacation', count(*)::integer from mail_vacation where org_id = ${orgId}
    union all select 'mail_vacation_responses', count(*)::integer from mail_vacation_responses where org_id = ${orgId}
    union all select 'mail_thread_state', count(*)::integer from mail_thread_state where org_id = ${orgId}
    union all select 'mail_outbound_messages', count(*)::integer from mail_outbound_messages where org_id = ${orgId}
    union all select 'mail_outbound_providers', count(*)::integer from mail_outbound_providers where org_id = ${orgId}
    union all select 'mail_sending_domains', count(*)::integer from mail_sending_domains where org_id = ${orgId}
    union all select 'mail_dkim_keys', count(*)::integer from mail_dkim_keys where org_id = ${orgId}
    union all select 'mail_dmarc_reports', count(*)::integer from mail_dmarc_reports where org_id = ${orgId}
    union all select 'mail_dmarc_report_records', count(*)::integer from mail_dmarc_report_records where org_id = ${orgId}
    union all select 'mail_inbound_routing_rules', count(*)::integer from mail_inbound_routing_rules where org_id = ${orgId}
    union all select 'drive_folders', count(*)::integer from drive_folders where org_id = ${orgId}
    union all select 'drive_versions', count(*)::integer from drive_versions where org_id = ${orgId}
    union all select 'drive_pdf_form_states', count(*)::integer from drive_pdf_form_states where org_id = ${orgId}
    union all select 'docs_documents', count(*)::integer from docs_documents where org_id = ${orgId}
    union all select 'docs_updates', count(*)::integer from docs_updates where org_id = ${orgId}
    union all select 'docs_comments', count(*)::integer from docs_comments where org_id = ${orgId}
    union all select 'docs_suggestions', count(*)::integer from docs_suggestions where org_id = ${orgId}
    union all select 'sheets', count(*)::integer from sheets where org_id = ${orgId}
    union all select 'sheet_tabs', count(*)::integer from sheet_tabs where org_id = ${orgId}
    union all select 'sheet_cells', count(*)::integer from sheet_cells where org_id = ${orgId}
    union all select 'sheet_op_log', count(*)::integer from sheet_op_log where org_id = ${orgId}
    union all select 'slide_decks', count(*)::integer from slide_decks where org_id = ${orgId}
    union all select 'slides', count(*)::integer from slides where org_id = ${orgId}
    union all select 'slides_op_log', count(*)::integer from slides_op_log where org_id = ${orgId}
    union all select 'cal_calendars', count(*)::integer from cal_calendars where org_id = ${orgId}
    union all select 'cal_calendar_memberships', count(*)::integer from cal_calendar_memberships where org_id = ${orgId}
    union all select 'cal_events', count(*)::integer from cal_events where org_id = ${orgId}
    union all select 'cal_attendees', count(*)::integer from cal_attendees where org_id = ${orgId}
    union all select 'carddav_contacts', count(*)::integer from carddav_contacts where org_id = ${orgId}
    union all select 'meet_rooms', count(*)::integer from meet_rooms where org_id = ${orgId}
    union all select 'chat_room_settings', count(*)::integer from chat_room_settings where org_id = ${orgId}
    union all select 'chat_reactions', count(*)::integer from chat_reactions where org_id = ${orgId}
    union all select 'chat_pins', count(*)::integer from chat_pins where org_id = ${orgId}
    union all select 'chat_read_receipts', count(*)::integer from chat_read_receipts where org_id = ${orgId}
    union all select 'notifications', count(*)::integer from notifications where org_id = ${orgId}
    union all select 'resource_classifications', count(*)::integer from resource_classifications where org_id = ${orgId}
    union all select 'seed_corpus_assets', count(*)::integer from seed_corpus_assets where org_id = ${orgId}
    order by table_name
  `) as unknown as readonly TenantExportTableCountRow[];
  return rows.map((row) => ({ table: row.table_name, rowCount: row.row_count }));
}

export async function summarizeTenantExportAudit(
  sql: postgres.Sql,
  orgId: string,
): Promise<TenantExportAuditSummary> {
  const rows = (await sql`
    select
      count(*)::integer as row_count,
      min(created_at) as first_entry_at,
      max(created_at) as last_entry_at
    from activity
    where org_id = ${orgId}
  `) as unknown as readonly TenantExportAuditSummaryRow[];
  const row = rows[0];
  return {
    rowCount: row?.row_count ?? 0,
    firstEntryAt: row?.first_entry_at?.toISOString() ?? null,
    lastEntryAt: row?.last_entry_at?.toISOString() ?? null,
  };
}

interface TenantExportArchiveFile {
  readonly path: string;
  readonly body: AsyncIterable<Uint8Array> | Uint8Array;
  readonly byteSize?: number | undefined;
}

interface MaterializedTenantExportArchiveFile {
  readonly path: string;
  readonly body: Uint8Array;
}

async function objectByteArchiveFiles(
  manifest: TenantExportManifest,
  resolver: TenantStorageResolver | undefined,
): Promise<readonly TenantExportArchiveFile[]> {
  if (resolver === undefined) {
    throw new Error("Tenant storage resolver is required to include export object bytes.");
  }
  const storage = await resolver({ orgId: manifest.org.id });
  if (storage === undefined) {
    throw new Error("Tenant storage resolver did not resolve storage for tenant export.");
  }
  const files: TenantExportArchiveFile[] = [];
  for (const object of manifest.objectInventory.objects) {
    const stored = await storage.client.get(object.storageKey);
    if (stored === null) {
      throw new Error(`Tenant export object bytes are unavailable: ${object.storageKey}`);
    }
    const bodySize =
      stored.body instanceof Uint8Array
        ? stored.body.byteLength
        : object.byteSize === undefined
          ? undefined
          : object.byteSize;
    files.push({
      path: objectArchivePath(object.storageKey),
      body: bodySize === undefined ? await storageObjectBodyBytes(stored.body) : stored.body,
      ...(bodySize === undefined ? {} : { byteSize: bodySize }),
    });
  }
  return files;
}

export async function buildTenantExportSelfFetchManifest(
  manifest: TenantExportManifest,
  options: BuildTenantExportSelfFetchManifestOptions,
): Promise<TenantExportSelfFetchManifest> {
  if (options.storageResolver === undefined) {
    throw new Error("Tenant storage resolver is required to presign export object bytes.");
  }
  const storage = await options.storageResolver({ orgId: manifest.org.id });
  if (storage === undefined) {
    throw new Error("Tenant storage resolver did not resolve storage for tenant export.");
  }
  if (storage.client.presignGetUrl === undefined) {
    throw new Error("Tenant export storage does not support presigned object fetch.");
  }
  const expiresSeconds = validatePresignedUrlExpiresSeconds(
    options.presignedUrlExpiresSeconds ?? 3600,
  );
  const now = options.now ?? (() => new Date());
  const expiresAt = new Date(now().getTime() + expiresSeconds * 1000).toISOString();
  const objects: TenantExportSelfFetchObject[] = [];
  for (const object of manifest.objectInventory.objects) {
    objects.push({
      storageKey: object.storageKey,
      ...(object.byteSize === undefined ? {} : { byteSize: object.byteSize }),
      ...(object.sha256 === undefined ? {} : { sha256: object.sha256 }),
      url: await storage.client.presignGetUrl(object.storageKey, { expiresSeconds }),
      expiresAt,
    });
  }
  return {
    version: tenantExportManifestVersion,
    generatedAt: manifest.generatedAt,
    org: {
      id: manifest.org.id,
      slug: manifest.org.slug,
    },
    delivery: "self-fetch",
    expiresAt,
    expiresSeconds,
    objects,
  };
}

async function storageObjectBodyBytes(body: StorageObject["body"]): Promise<Uint8Array> {
  return archiveFileBodyBytes(body);
}

async function archiveFileBodyBytes(
  body: AsyncIterable<Uint8Array> | Uint8Array,
): Promise<Uint8Array> {
  if (Symbol.asyncIterator in body) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  return body;
}

function objectArchivePath(storageKey: string): string {
  const normalized = storageKey.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..") ||
    hasControlCharacter(normalized)
  ) {
    throw new Error(`Unsafe tenant export object storage key: ${storageKey}`);
  }
  return `objects/${normalized}`;
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function buildTenantExportPostgresDataChunkFile(input: {
  readonly table: string;
  readonly path: string;
  readonly orderBy: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
}): TenantExportPostgresDataChunkFile {
  const body = jsonlBytes(input.rows);
  return {
    metadata: {
      table: input.table,
      path: input.path,
      rowCount: input.rows.length,
      byteSize: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
      orderBy: input.orderBy,
    },
    body,
  };
}

function tenantExportPostgresDataChunkArchiveFiles(
  chunks: readonly TenantExportPostgresDataChunkFile[],
): readonly TenantExportArchiveFile[] {
  return chunks.map((chunk) => ({
    path: chunk.metadata.path,
    body: chunk.body,
    byteSize: chunk.body.byteLength,
  }));
}

function buildTenantExportPostgresDataChunkManifest(
  chunks: readonly TenantExportPostgresDataChunkFile[],
): TenantExportPostgresDataChunkManifest {
  return {
    version: 1,
    format: "jsonl",
    chunks: chunks.map((chunk) => chunk.metadata),
    includedTables: chunks.map((chunk) => chunk.metadata.table),
    excludedTables: [
      {
        table: "app_passwords",
        reason: "credential_material",
        detail: "App password hashes are credential material and are never exported as row data.",
      },
      {
        table: "agent_credentials",
        reason: "credential_material",
        detail: "Agent client secrets, API key hashes, and certificate material require reissue.",
      },
      {
        table: "oauth_access_tokens",
        reason: "token_material",
        detail: "OAuth token hashes are ephemeral token material and are not portable.",
      },
      {
        table: "oauth_authorization_codes",
        reason: "token_material",
        detail: "Authorization code hashes are short-lived token material and are not portable.",
      },
      {
        table: "outbound_webhooks",
        reason: "customer_secret",
        detail: "Webhook secret references and headers require tenant-controlled redaction rules.",
      },
      {
        table: "inbound_webhooks",
        reason: "customer_secret",
        detail: "Webhook secret references require tenant-controlled redaction rules.",
      },
      {
        table: "webhook_deliveries",
        reason: "webhook_payload",
        detail: "Webhook delivery payloads and signatures can contain customer data and secrets.",
      },
      {
        table: "activity",
        reason: "content_body",
        detail: "Audit payloads are summarized separately until redacted row export is available.",
      },
      {
        table: "docs_documents",
        reason: "content_body",
        detail:
          "Document bodies and CRDT state require import-compatible redaction and replay rules.",
      },
      {
        table: "mail_outbound_messages",
        reason: "content_body",
        detail:
          "Mail bodies and recipient payloads require content export policy before row export.",
      },
    ],
    notes: [
      "This archive emits only explicitly allowlisted PostgreSQL metadata row-data chunks.",
      "Future chunks are append-only JSONL under postgres/data/chunks/<table>/000000.jsonl.",
      "Sensitive, credential, token, webhook payload, and content-body tables require explicit redaction before row export.",
    ],
  };
}

function jsonlBytes(rows: readonly Record<string, unknown>[]): Uint8Array {
  return textBytes(
    rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""),
  );
}

function exportReadme(manifest: TenantExportManifest): string {
  const byteLine = manifest.objectInventory.bytesIncluded
    ? "This archive includes object-store bytes under objects/."
    : "It intentionally does not include object bytes unless objects/self-fetch-manifest.json is present.";
  const rowChunkLine =
    manifest.postgres.rowDataChunks.chunks.length === 0
      ? "It includes PostgreSQL row-data chunk metadata at postgres/data/chunks/manifest.json, but emits no row-data chunk files yet."
      : "It includes allowlisted PostgreSQL metadata row-data chunks under postgres/data/chunks/ and describes them in postgres/data/chunks/manifest.json.";
  return [
    `# Helix Tenant Export: ${manifest.org.slug}`,
    "",
    `Generated: ${manifest.generatedAt}`,
    `Export manifest version: ${String(manifest.version)}`,
    `Tenant status: ${manifest.org.status}`,
    "",
    "This bounded v1 archive contains the tenant export manifest, tenant config snapshot,",
    "logical object inventory, org-scoped table row counts, and audit-log summary.",
    byteLine,
    "",
    rowChunkLine,
    "Private credentials, token hashes, webhook payloads, document/mail bodies, and encrypted",
    "customer secrets remain excluded until explicit redaction and import compatibility rules are implemented.",
    "",
  ].join("\n");
}

function stableJson(value: unknown): Uint8Array {
  return textBytes(`${JSON.stringify(value, null, 2)}\n`);
}

function textBytes(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

function archiveTimestamp(value: string): string {
  const date = new Date(value);
  const iso = Number.isNaN(date.getTime()) ? value : date.toISOString();
  return iso
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}/u, "")
    .replace(/[^\dTZ]/gu, "");
}

function validatePresignedUrlExpiresSeconds(expiresSeconds: number): number {
  if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 604_800) {
    throw new Error("Tenant export presigned URL expiry must be between 1 and 604800 seconds.");
  }
  return expiresSeconds;
}

function defaultArchiveArtifactStorageKey(
  manifest: TenantExportManifest,
  filename: string,
): string {
  const slug = manifest.org.slug.replace(/[^a-z0-9-]/giu, "-").toLowerCase();
  return `tenant-exports/${slug}/${filename}`;
}

function buildTarArchive(
  files: readonly MaterializedTenantExportArchiveFile[],
  mtimeSeconds: number,
): Buffer {
  return Buffer.concat([
    ...files.flatMap((file) => tarEntry({ ...file, body: Buffer.from(file.body) }, mtimeSeconds)),
    Buffer.alloc(1024),
  ]);
}

async function* streamTarArchive(
  files: readonly TenantExportArchiveFile[],
  mtimeSeconds: number,
): AsyncIterable<Uint8Array> {
  for (const file of files) {
    const size = archiveFileSize(file);
    yield tarHeader({ path: file.path, size, mtimeSeconds });
    let emitted = 0;
    for await (const chunk of bodyChunks(file.body)) {
      emitted += chunk.byteLength;
      yield chunk;
    }
    if (emitted !== size) {
      throw new Error(
        `Tenant export stream size mismatch for ${file.path}: expected ${String(size)}, emitted ${String(
          emitted,
        )}`,
      );
    }
    yield Buffer.alloc((512 - (size % 512)) % 512);
  }
  yield Buffer.alloc(1024);
}

function tarArchiveByteSize(files: readonly TenantExportArchiveFile[]): number {
  return (
    files.reduce((total, file) => {
      const size = archiveFileSize(file);
      return total + 512 + size + ((512 - (size % 512)) % 512);
    }, 0) + 1024
  );
}

function archiveFileSize(file: TenantExportArchiveFile): number {
  const size =
    file.byteSize ?? (file.body instanceof Uint8Array ? file.body.byteLength : undefined);
  if (size === undefined) {
    throw new Error(`Tenant export stream cannot determine tar entry size: ${file.path}`);
  }
  return size;
}

async function* bodyChunks(
  body: AsyncIterable<Uint8Array> | Uint8Array,
): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in body) {
    for await (const chunk of body) {
      yield chunk;
    }
    return;
  }
  yield body;
}

function tarEntry(
  file: TenantExportArchiveFile & { readonly body: Uint8Array },
  mtimeSeconds: number,
): readonly Buffer[] {
  const body = Buffer.from(file.body);
  const header = tarHeader({
    path: file.path,
    size: body.byteLength,
    mtimeSeconds,
  });
  const padding = Buffer.alloc((512 - (body.byteLength % 512)) % 512);
  return [header, body, padding];
}

function tarHeader(input: {
  readonly path: string;
  readonly size: number;
  readonly mtimeSeconds: number;
}): Buffer {
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, input.path);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, input.size);
  writeTarOctal(header, 136, 12, input.mtimeSeconds);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  writeTarString(header, 265, 32, "helix");
  writeTarString(header, 297, 32, "helix");
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function writeTarString(buffer: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > length) {
    throw new Error(`Tar path is too long for ustar header: ${value}`);
  }
  bytes.copy(buffer, offset, 0, bytes.byteLength);
}

function writeTarOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(
    `${Math.trunc(value)
      .toString(8)
      .padStart(length - 1, "0")}\0`,
    offset,
    length,
  );
}
