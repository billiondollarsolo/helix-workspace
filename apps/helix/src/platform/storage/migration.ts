import { createHash } from "node:crypto";
import type postgres from "postgres";
import type { JsonObject, StorageObject } from "@helix/sdk-types";
import { withJobSpan } from "../observability/job-span.js";
import type {
  ResolvedTenantStorage,
  TenantStorageClient,
  TenantStorageResolver,
  TenantStorageStateSnapshot,
} from "./tenant-resolver.js";

export type TenantStorageMigrationTarget = "byo" | "helix-default";

export interface TenantStorageMigrationObject {
  readonly storageKey: string;
  readonly byteSize?: number | undefined;
  readonly sha256?: string | undefined;
}

export interface TenantStorageMigrationFailure {
  readonly storageKey: string;
  readonly reason: string;
}

export interface TenantStorageMigrationResult {
  readonly orgId: string;
  readonly target: TenantStorageMigrationTarget;
  readonly status: "completed" | "dry_run" | "completed_with_errors";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly plannedCount: number;
  readonly copiedCount: number;
  readonly verifiedCount: number;
  readonly failures: readonly TenantStorageMigrationFailure[];
}

export interface RunTenantStorageMigrationInput {
  readonly orgId: string;
  readonly target: TenantStorageMigrationTarget;
  readonly objects: readonly TenantStorageMigrationObject[];
  readonly source: TenantStorageClient;
  readonly destination: TenantStorageClient;
  readonly dryRun?: boolean | undefined;
  readonly now?: (() => Date) | undefined;
}

export type TenantStorageMigrationJobStatus =
  "queued" | "running" | "succeeded" | "succeeded_with_errors" | "failed" | "dry_run";

export interface TenantStorageMigrationStorageState {
  readonly managedBy: TenantStorageMigrationTarget;
  readonly storage: JsonObject | null;
}

export interface TenantStorageMigrationJobRecord {
  readonly id: string;
  readonly orgId: string;
  readonly target: TenantStorageMigrationTarget;
  readonly status: TenantStorageMigrationJobStatus;
  readonly dryRun: boolean;
  readonly requestedByActorId: string | null;
  readonly sourceStorage: TenantStorageMigrationStorageState | null;
  readonly targetStorage: TenantStorageMigrationStorageState | null;
  readonly plannedCount: number;
  readonly copiedCount: number;
  readonly verifiedCount: number;
  readonly failures: readonly TenantStorageMigrationFailure[];
  readonly lastError: string | null;
  readonly attemptCount: number;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateTenantStorageMigrationJobInput {
  readonly orgId: string;
  readonly target: TenantStorageMigrationTarget;
  readonly dryRun?: boolean | undefined;
  readonly requestedByActorId?: string | null | undefined;
  readonly sourceStorage?: TenantStorageMigrationStorageState | null | undefined;
  readonly targetStorage?: TenantStorageMigrationStorageState | null | undefined;
}

export interface TenantStorageMigrationJobStore {
  create(input: CreateTenantStorageMigrationJobInput): Promise<TenantStorageMigrationJobRecord>;
  findByIdForOrg(input: {
    readonly id: string;
    readonly orgId: string;
  }): Promise<TenantStorageMigrationJobRecord | null>;
  claimPending(input?: {
    readonly limit?: number | undefined;
  }): Promise<readonly TenantStorageMigrationJobRecord[]>;
  markCompleted(input: {
    readonly id: string;
    readonly result: TenantStorageMigrationResult;
  }): Promise<TenantStorageMigrationJobRecord>;
  markFailed(input: {
    readonly id: string;
    readonly error: string;
  }): Promise<TenantStorageMigrationJobRecord>;
}

export interface TenantStorageMigrationStoragePair {
  readonly source: TenantStorageClient;
  readonly destination: TenantStorageClient;
}

export type TenantStorageMigrationPairResolver = (
  job: TenantStorageMigrationJobRecord,
) => Promise<TenantStorageMigrationStoragePair> | TenantStorageMigrationStoragePair;

export interface TenantStorageMigrationPairResolverOptions {
  readonly currentStorageResolver: TenantStorageResolver;
  readonly helixDefaultStorageResolver: TenantStorageResolver | undefined;
  readonly snapshotStorageResolver?:
    | ((input: {
        readonly orgId: string;
        readonly state: TenantStorageStateSnapshot;
      }) => Promise<ResolvedTenantStorage | undefined> | ResolvedTenantStorage | undefined)
    | undefined;
}

export interface TenantStorageMigrationWorkerOptions {
  readonly store: Pick<
    TenantStorageMigrationJobStore,
    "claimPending" | "markCompleted" | "markFailed"
  >;
  readonly resolveStoragePair: TenantStorageMigrationPairResolver;
  readonly listObjects?: (
    orgId: string,
  ) => Promise<readonly TenantStorageMigrationObject[]> | readonly TenantStorageMigrationObject[];
  readonly sql?: postgres.Sql | undefined;
  readonly intervalMs?: number | undefined;
  readonly batchSize?: number | undefined;
  readonly onResult?: (result: TenantStorageMigrationWorkerRunResult) => void;
  readonly onError?: (error: unknown) => void;
}

export interface TenantStorageMigrationWorkerRunResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly dryRun: number;
  readonly failed: number;
}

interface TenantStorageMigrationObjectRow {
  readonly storage_key: string | null;
  readonly byte_size: number | null;
  readonly sha256: string | null;
}

interface TenantStorageMigrationJobRow {
  readonly id: string;
  readonly org_id: string;
  readonly target: TenantStorageMigrationTarget;
  readonly status: TenantStorageMigrationJobStatus;
  readonly dry_run: boolean;
  readonly requested_by_actor_id: string | null;
  readonly source_storage: TenantStorageMigrationStorageState | null;
  readonly target_storage: TenantStorageMigrationStorageState | null;
  readonly planned_count: number;
  readonly copied_count: number;
  readonly verified_count: number;
  readonly failures: readonly TenantStorageMigrationFailure[];
  readonly last_error: string | null;
  readonly attempt_count: number;
  readonly started_at: Date | null;
  readonly completed_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export async function listTenantStorageMigrationObjects(
  sql: postgres.Sql,
  orgId: string,
): Promise<readonly TenantStorageMigrationObject[]> {
  const rows = (await sql`
    select distinct on (stored.storage_key)
      stored.storage_key, stored.byte_size, stored.sha256
    from (
      select storage_key, byte_size, sha256, 0 as source_rank
      from objects
      where org_id = ${orgId}
        and storage_key <> ''

      union all

      select v.storage_key, v.byte_size, v.sha256, 1 as source_rank
      from drive_versions v
      join objects o on o.id = v.object_id and o.org_id = v.org_id
      where v.org_id = ${orgId}
        and v.storage_key <> ''

      union all

      select
        metadata->'preview'->>'storageKey' as storage_key,
        null::integer as byte_size,
        null::text as sha256,
        2 as source_rank
      from objects
      where org_id = ${orgId}
        and metadata->'preview'->>'storageKey' is not null
        and metadata->'preview'->>'storageKey' <> ''
    ) stored
    where stored.storage_key is not null
    order by stored.storage_key, stored.source_rank
  `) as unknown as readonly TenantStorageMigrationObjectRow[];

  return rows.flatMap((row) => {
    const storageKey = row.storage_key?.trim();
    if (storageKey === undefined || storageKey.length === 0) {
      return [];
    }
    return [
      {
        storageKey,
        ...(row.byte_size === null ? {} : { byteSize: row.byte_size }),
        ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
      },
    ];
  });
}

export class PostgresTenantStorageMigrationJobStore implements TenantStorageMigrationJobStore {
  constructor(private readonly sql: postgres.Sql) {}

  async create(
    input: CreateTenantStorageMigrationJobInput,
  ): Promise<TenantStorageMigrationJobRecord> {
    const rows = (await this.sql`
      insert into tenant_storage_migration_jobs (
        org_id,
        target,
        dry_run,
        requested_by_actor_id,
        source_storage,
        target_storage
      )
      values (
        ${input.orgId},
        ${input.target},
        ${input.dryRun === true},
        ${input.requestedByActorId ?? null},
        ${
          input.sourceStorage === undefined || input.sourceStorage === null
            ? null
            : this.sql.json(input.sourceStorage as unknown as Parameters<postgres.Sql["json"]>[0])
        },
        ${
          input.targetStorage === undefined || input.targetStorage === null
            ? null
            : this.sql.json(input.targetStorage as unknown as Parameters<postgres.Sql["json"]>[0])
        }
      )
      returning
        id,
        org_id,
        target,
        status,
        dry_run,
        requested_by_actor_id,
        source_storage,
        target_storage,
        planned_count,
        copied_count,
        verified_count,
        failures,
        last_error,
        attempt_count,
        started_at,
        completed_at,
        created_at,
        updated_at
    `) as unknown as readonly TenantStorageMigrationJobRow[];
    return mapTenantStorageMigrationJobRow(rows[0]);
  }

  async findByIdForOrg(input: {
    readonly id: string;
    readonly orgId: string;
  }): Promise<TenantStorageMigrationJobRecord | null> {
    const rows = (await this.sql`
      select
        id,
        org_id,
        target,
        status,
        dry_run,
        requested_by_actor_id,
        source_storage,
        target_storage,
        planned_count,
        copied_count,
        verified_count,
        failures,
        last_error,
        attempt_count,
        started_at,
        completed_at,
        created_at,
        updated_at
      from tenant_storage_migration_jobs
      where id = ${input.id}
        and org_id = ${input.orgId}
      limit 1
    `) as unknown as readonly TenantStorageMigrationJobRow[];
    return rows[0] === undefined ? null : mapTenantStorageMigrationJobRow(rows[0]);
  }

  async claimPending(
    input: { readonly limit?: number | undefined } = {},
  ): Promise<readonly TenantStorageMigrationJobRecord[]> {
    const limit = input.limit ?? 5;
    const rows = (await this.sql`
      update tenant_storage_migration_jobs
      set
        status = 'running',
        attempt_count = attempt_count + 1,
        last_error = null,
        started_at = coalesce(started_at, now()),
        updated_at = now()
      where id in (
        select id
        from tenant_storage_migration_jobs
        where status in ('queued', 'failed')
        order by updated_at asc
        limit ${limit}
        for update skip locked
      )
      returning
        id,
        org_id,
        target,
        status,
        dry_run,
        requested_by_actor_id,
        source_storage,
        target_storage,
        planned_count,
        copied_count,
        verified_count,
        failures,
        last_error,
        attempt_count,
        started_at,
        completed_at,
        created_at,
        updated_at
    `) as unknown as readonly TenantStorageMigrationJobRow[];
    return rows.map(mapTenantStorageMigrationJobRow);
  }

  async markCompleted(input: {
    readonly id: string;
    readonly result: TenantStorageMigrationResult;
  }): Promise<TenantStorageMigrationJobRecord> {
    const rows = (await this.sql`
      update tenant_storage_migration_jobs
      set
        status = ${jobStatusFromMigrationResult(input.result)},
        planned_count = ${input.result.plannedCount},
        copied_count = ${input.result.copiedCount},
        verified_count = ${input.result.verifiedCount},
        failures = ${this.sql.json([...input.result.failures] as unknown as Parameters<
          postgres.Sql["json"]
        >[0])},
        last_error = null,
        completed_at = now(),
        updated_at = now()
      where id = ${input.id}
      returning
        id,
        org_id,
        target,
        status,
        dry_run,
        requested_by_actor_id,
        source_storage,
        target_storage,
        planned_count,
        copied_count,
        verified_count,
        failures,
        last_error,
        attempt_count,
        started_at,
        completed_at,
        created_at,
        updated_at
    `) as unknown as readonly TenantStorageMigrationJobRow[];
    return mapTenantStorageMigrationJobRow(rows[0]);
  }

  async markFailed(input: {
    readonly id: string;
    readonly error: string;
  }): Promise<TenantStorageMigrationJobRecord> {
    const rows = (await this.sql`
      update tenant_storage_migration_jobs
      set
        status = 'failed',
        last_error = ${input.error},
        completed_at = now(),
        updated_at = now()
      where id = ${input.id}
      returning
        id,
        org_id,
        target,
        status,
        dry_run,
        requested_by_actor_id,
        source_storage,
        target_storage,
        planned_count,
        copied_count,
        verified_count,
        failures,
        last_error,
        attempt_count,
        started_at,
        completed_at,
        created_at,
        updated_at
    `) as unknown as readonly TenantStorageMigrationJobRow[];
    return mapTenantStorageMigrationJobRow(rows[0]);
  }
}

const defaultMigrationWorkerIntervalMs = 15_000;
const defaultMigrationWorkerBatchSize = 2;

export class TenantStorageMigrationWorker {
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly onResult: ((result: TenantStorageMigrationWorkerRunResult) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<TenantStorageMigrationWorkerRunResult> | undefined;

  constructor(private readonly options: TenantStorageMigrationWorkerOptions) {
    this.intervalMs = options.intervalMs ?? defaultMigrationWorkerIntervalMs;
    this.batchSize = options.batchSize ?? defaultMigrationWorkerBatchSize;
    this.onResult = options.onResult;
    this.onError = options.onError;
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runScheduledMigration();
    }, this.intervalMs);
    this.timer.unref();
    void this.runScheduledMigration();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.activeRun !== undefined) {
      await this.activeRun;
    }
  }

  async runOnce(): Promise<TenantStorageMigrationWorkerRunResult> {
    return withJobSpan("tenant-storage-migration", async () => {
      const jobs = await this.options.store.claimPending({ limit: this.batchSize });
      let succeeded = 0;
      let dryRun = 0;
      let failed = 0;

      for (const job of jobs) {
        try {
          await withJobSpan("tenant-storage-migration.job", async () => {
            const objects = await this.listObjects(job.orgId);
            const pair = job.dryRun
              ? dryRunStoragePair
              : await this.resolveLiveMigrationStoragePair(job);
            const result = await runTenantStorageMigration({
              orgId: job.orgId,
              target: job.target,
              objects,
              source: pair.source,
              destination: pair.destination,
              dryRun: job.dryRun,
            });
            await this.options.store.markCompleted({ id: job.id, result });
            if (result.status === "dry_run") {
              dryRun += 1;
            } else {
              succeeded += 1;
            }
          });
        } catch (error) {
          await this.options.store.markFailed({ id: job.id, error: errorMessage(error) });
          failed += 1;
        }
      }

      return { claimed: jobs.length, succeeded, dryRun, failed };
    });
  }

  private listObjects(orgId: string): Promise<readonly TenantStorageMigrationObject[]> {
    if (this.options.listObjects !== undefined) {
      return Promise.resolve(this.options.listObjects(orgId));
    }
    if (this.options.sql === undefined) {
      throw new Error("Tenant storage migration worker needs either listObjects or sql.");
    }
    return listTenantStorageMigrationObjects(this.options.sql, orgId);
  }

  private resolveLiveMigrationStoragePair(
    job: TenantStorageMigrationJobRecord,
  ): Promise<TenantStorageMigrationStoragePair> | TenantStorageMigrationStoragePair {
    assertLiveMigrationSnapshots(job);
    return this.options.resolveStoragePair(job);
  }

  private runScheduledMigration(): Promise<TenantStorageMigrationWorkerRunResult> {
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
        return { claimed: 0, succeeded: 0, dryRun: 0, failed: 0 };
      })
      .finally(() => {
        this.activeRun = undefined;
      });
    this.activeRun = activeRun;
    return activeRun;
  }
}

export function assertLiveMigrationSnapshots(job: TenantStorageMigrationJobRecord): void {
  assertLiveMigrationStorageStates({
    target: job.target,
    sourceStorage: job.sourceStorage,
    targetStorage: job.targetStorage,
  });
}

export function assertLiveMigrationStorageStates(input: {
  readonly target: TenantStorageMigrationTarget;
  readonly sourceStorage: TenantStorageMigrationStorageState | null;
  readonly targetStorage: TenantStorageMigrationStorageState | null;
}): void {
  if (input.sourceStorage === null || input.targetStorage === null) {
    throw new Error(
      "Live tenant storage migration requires staged source and target storage snapshots.",
    );
  }
  if (input.target === "byo") {
    if (
      input.sourceStorage.managedBy !== "helix-default" ||
      input.targetStorage.managedBy !== "byo"
    ) {
      throw new Error(
        "Live migration to BYO requires helix-default source and BYO target snapshots.",
      );
    }
    if (input.targetStorage.storage === null) {
      throw new Error("Live migration to BYO requires a staged BYO target storage config.");
    }
    return;
  }
  if (
    input.sourceStorage.managedBy !== "byo" ||
    input.targetStorage.managedBy !== "helix-default"
  ) {
    throw new Error(
      "Live migration to helix-default requires BYO source and helix-default target snapshots.",
    );
  }
  if (input.sourceStorage.storage === null) {
    throw new Error("Live migration to helix-default requires a staged BYO source storage config.");
  }
}

export function createTenantStorageMigrationPairResolver(
  options: TenantStorageMigrationPairResolverOptions,
): TenantStorageMigrationPairResolver {
  return async (job) => {
    if (job.sourceStorage !== null && job.targetStorage !== null) {
      if (options.snapshotStorageResolver === undefined) {
        throw new Error("Tenant storage snapshot resolver is not configured.");
      }
      const source = await options.snapshotStorageResolver({
        orgId: job.orgId,
        state: job.sourceStorage,
      });
      const destination = await options.snapshotStorageResolver({
        orgId: job.orgId,
        state: job.targetStorage,
      });
      if (source === undefined || destination === undefined) {
        throw new Error("Staged tenant storage snapshot could not be resolved.");
      }
      return {
        source: source.client,
        destination: destination.client,
      };
    }

    const current = await options.currentStorageResolver({ orgId: job.orgId, refresh: true });
    if (current === undefined) {
      throw new Error("Tenant storage is not configured.");
    }
    const helixDefault = await options.helixDefaultStorageResolver?.({
      orgId: job.orgId,
      refresh: true,
    });
    if (helixDefault === undefined) {
      throw new Error("Helix-default tenant storage is not configured.");
    }

    if (job.target === "byo") {
      if (current.managedBy !== "byo") {
        throw new Error("BYO storage config must be active before migrating to BYO.");
      }
      return {
        source: helixDefault.client,
        destination: current.client,
      };
    }

    if (current.managedBy !== "byo") {
      throw new Error("Tenant is not currently using BYO storage.");
    }
    return {
      source: current.client,
      destination: helixDefault.client,
    };
  };
}

export async function runTenantStorageMigration(
  input: RunTenantStorageMigrationInput,
): Promise<TenantStorageMigrationResult> {
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const objects = uniqueMigrationObjects(input.objects);
  if (input.dryRun === true) {
    return {
      orgId: input.orgId,
      target: input.target,
      status: "dry_run",
      startedAt,
      completedAt: now().toISOString(),
      plannedCount: objects.length,
      copiedCount: 0,
      verifiedCount: 0,
      failures: [],
    };
  }

  let copiedCount = 0;
  let verifiedCount = 0;
  const failures: TenantStorageMigrationFailure[] = [];

  for (const object of objects) {
    try {
      const sourceObject = await input.source.get(object.storageKey);
      if (sourceObject === null) {
        failures.push({
          storageKey: object.storageKey,
          reason: "Source object was not found.",
        });
        continue;
      }

      const body = await storageBodyBytes(sourceObject.body);
      const verification = verifyMigrationObject(object, body);
      if (verification !== undefined) {
        failures.push({ storageKey: object.storageKey, reason: verification });
        continue;
      }

      await input.destination.put({
        key: object.storageKey,
        body,
        ...(sourceObject.contentType === undefined
          ? {}
          : { contentType: sourceObject.contentType }),
        ...(sourceObject.metadata === undefined ? {} : { metadata: sourceObject.metadata }),
      });
      copiedCount += 1;

      const copied = await input.destination.get(object.storageKey);
      if (copied === null) {
        failures.push({
          storageKey: object.storageKey,
          reason: "Destination object was not readable after copy.",
        });
        continue;
      }
      const copiedBody = await storageBodyBytes(copied.body);
      const copiedVerification = verifyMigrationObject(object, copiedBody);
      if (copiedVerification !== undefined || sha256Hex(copiedBody) !== sha256Hex(body)) {
        failures.push({
          storageKey: object.storageKey,
          reason: copiedVerification ?? "Destination object hash did not match source object.",
        });
        continue;
      }
      verifiedCount += 1;
    } catch (error) {
      failures.push({
        storageKey: object.storageKey,
        reason: error instanceof Error && error.message.length > 0 ? error.message : "Copy failed.",
      });
    }
  }

  return {
    orgId: input.orgId,
    target: input.target,
    status: failures.length === 0 ? "completed" : "completed_with_errors",
    startedAt,
    completedAt: now().toISOString(),
    plannedCount: objects.length,
    copiedCount,
    verifiedCount,
    failures,
  };
}

const dryRunStorageClient: TenantStorageClient = {
  async put(): Promise<void> {
    throw new Error("Dry-run tenant storage migration must not write objects.");
  },
  async get(): Promise<StorageObject | null> {
    throw new Error("Dry-run tenant storage migration must not read objects.");
  },
  async delete(): Promise<void> {
    throw new Error("Dry-run tenant storage migration must not delete objects.");
  },
};

const dryRunStoragePair: TenantStorageMigrationStoragePair = {
  source: dryRunStorageClient,
  destination: dryRunStorageClient,
};

function uniqueMigrationObjects(
  objects: readonly TenantStorageMigrationObject[],
): readonly TenantStorageMigrationObject[] {
  const byKey = new Map<string, TenantStorageMigrationObject>();
  for (const object of objects) {
    const storageKey = object.storageKey.trim().replace(/^\/+/u, "");
    if (storageKey.length === 0 || byKey.has(storageKey)) {
      continue;
    }
    byKey.set(storageKey, { ...object, storageKey });
  }
  return [...byKey.values()];
}

function verifyMigrationObject(
  object: TenantStorageMigrationObject,
  body: Uint8Array,
): string | undefined {
  if (object.byteSize !== undefined && body.byteLength !== object.byteSize) {
    return `Object byte size mismatch: expected ${String(object.byteSize)}, got ${String(body.byteLength)}.`;
  }
  if (object.sha256 !== undefined && sha256Hex(body) !== object.sha256.toLowerCase()) {
    return "Object sha256 mismatch.";
  }
  return undefined;
}

async function storageBodyBytes(body: StorageObject["body"]): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return body;
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sha256Hex(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function jobStatusFromMigrationResult(
  result: TenantStorageMigrationResult,
): TenantStorageMigrationJobStatus {
  if (result.status === "completed") {
    return "succeeded";
  }
  if (result.status === "completed_with_errors") {
    return "succeeded_with_errors";
  }
  return "dry_run";
}

function mapTenantStorageMigrationJobRow(
  row: TenantStorageMigrationJobRow | undefined,
): TenantStorageMigrationJobRecord {
  if (row === undefined) {
    throw new Error("tenant storage migration job query returned no rows");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    target: row.target,
    status: row.status,
    dryRun: row.dry_run,
    requestedByActorId: row.requested_by_actor_id,
    sourceStorage: row.source_storage,
    targetStorage: row.target_storage,
    plannedCount: row.planned_count,
    copiedCount: row.copied_count,
    verifiedCount: row.verified_count,
    failures: row.failures,
    lastError: row.last_error,
    attemptCount: row.attempt_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}
