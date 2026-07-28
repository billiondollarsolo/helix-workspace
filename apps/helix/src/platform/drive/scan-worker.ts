import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { SecurityScanResult } from "@helix/contracts";
import type { JsonObject, SecurityTier } from "@helix/sdk-types";
import type { TenantStorageResolver } from "../storage/index.js";
import {
  safelyRecordSecurityMetric,
  type SecurityScanningMetrics,
} from "../security/scanning/index.js";
import { appendDriveActivity, type DriveStorageClient } from "./store.js";
import {
  assertDriveMalwareScannerReady,
  type VirusScanResult,
  type VirusScanner,
} from "./scanning.js";
import type { DriveUploadState } from "./upload-state.js";

export interface DriveScanJob {
  readonly id: string;
  readonly orgId: string;
  readonly objectId: string;
  readonly versionId: string;
  readonly requestedByActorId: string;
  readonly storageKey: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly uploadState: DriveUploadState;
  readonly deletedAt: Date | null;
}

export type DriveScanSettlement =
  | {
      readonly kind: "active";
      readonly scan: SecurityScanResult;
      readonly disposition: "allow" | "allow_unscanned";
    }
  | { readonly kind: "quarantined"; readonly scan: SecurityScanResult }
  | {
      readonly kind: "retry";
      readonly scan?: SecurityScanResult;
      readonly errorCode: string;
      readonly retryAt: Date;
    }
  | { readonly kind: "scan_failed"; readonly scan?: SecurityScanResult; readonly errorCode: string }
  | { readonly kind: "cancelled"; readonly errorCode: string };

export interface DriveScanJobRepository {
  claim(input: {
    readonly workerId: string;
    readonly limit: number;
    readonly leaseMs: number;
  }): Promise<readonly DriveScanJob[]>;
  settle(input: {
    readonly workerId: string;
    readonly job: DriveScanJob;
    readonly settlement: DriveScanSettlement;
  }): Promise<boolean>;
}

export interface DriveUploadScanWorkerOptions {
  readonly repository: DriveScanJobRepository;
  readonly scanner: VirusScanner;
  readonly storageForOrg: (orgId: string) => Promise<DriveStorageClient | undefined>;
  readonly workerId?: string;
  readonly concurrency?: number;
  readonly queueDepth?: number;
  readonly leaseMs?: number;
  readonly intervalMs?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly metrics?: SecurityScanningMetrics;
  readonly onError?: (error: unknown) => void;
}

export interface DriveScanDrainResult {
  readonly claimed: number;
  readonly active: number;
  readonly quarantined: number;
  readonly retried: number;
  readonly failed: number;
  readonly cancelled: number;
}

export class DriveUploadScanWorker {
  readonly #options: Required<
    Pick<
      DriveUploadScanWorkerOptions,
      | "workerId"
      | "concurrency"
      | "queueDepth"
      | "leaseMs"
      | "intervalMs"
      | "retryBaseMs"
      | "retryMaxMs"
    >
  > &
    DriveUploadScanWorkerOptions;
  #timer: NodeJS.Timeout | undefined;
  #activeDrain: Promise<DriveScanDrainResult> | undefined;

  constructor(options: DriveUploadScanWorkerOptions) {
    const concurrency = boundedInteger(options.concurrency ?? 2, 1, 32, "concurrency");
    this.#options = {
      ...options,
      workerId: options.workerId ?? `drive-scan-${randomUUID()}`,
      concurrency,
      queueDepth: boundedInteger(
        options.queueDepth ?? concurrency * 4,
        concurrency,
        1_000,
        "queueDepth",
      ),
      leaseMs: boundedInteger(options.leaseMs ?? 120_000, 10_000, 15 * 60_000, "leaseMs"),
      intervalMs: boundedInteger(options.intervalMs ?? 1_000, 100, 60_000, "intervalMs"),
      retryBaseMs: boundedInteger(options.retryBaseMs ?? 5_000, 100, 60 * 60_000, "retryBaseMs"),
      retryMaxMs: boundedInteger(
        options.retryMaxMs ?? 5 * 60_000,
        1_000,
        24 * 60 * 60_000,
        "retryMaxMs",
      ),
    };
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => void this.#runScheduledDrain(), this.#options.intervalMs);
    void this.#runScheduledDrain();
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.#activeDrain;
  }

  async drainOnce(): Promise<DriveScanDrainResult> {
    const jobs = await this.#options.repository.claim({
      workerId: this.#options.workerId,
      limit: Math.min(this.#options.concurrency, this.#options.queueDepth),
      leaseMs: this.#options.leaseMs,
    });
    safelyRecordSecurityMetric(() => {
      this.#options.metrics?.setSecurityScanBacklog({
        scannerName: this.#options.scanner.kind ?? "drive-scanner",
        pendingItems: jobs.length,
      });
    });
    const outcomes = await Promise.all(jobs.map((job) => this.#process(job)));
    return {
      claimed: jobs.length,
      active: outcomes.filter((outcome) => outcome === "active").length,
      quarantined: outcomes.filter((outcome) => outcome === "quarantined").length,
      retried: outcomes.filter((outcome) => outcome === "retry").length,
      failed: outcomes.filter((outcome) => outcome === "scan_failed").length,
      cancelled: outcomes.filter((outcome) => outcome === "cancelled").length,
    };
  }

  async #process(job: DriveScanJob): Promise<DriveScanSettlement["kind"]> {
    let settlement: DriveScanSettlement;
    if (job.deletedAt !== null || job.uploadState === "trashed") {
      settlement = { kind: "cancelled", errorCode: "object_deleted" };
    } else {
      settlement = await this.#scan(job);
    }
    const applied = await this.#options.repository.settle({
      workerId: this.#options.workerId,
      job,
      settlement,
    });
    return applied ? settlement.kind : "cancelled";
  }

  async #scan(job: DriveScanJob): Promise<DriveScanSettlement> {
    try {
      const storage = await this.#options.storageForOrg(job.orgId);
      const object = await storage?.get(job.storageKey);
      if (object === undefined || object === null) {
        return this.#retryOrFail(job, "storage_missing");
      }
      const result = await this.#options.scanner.scan(object.body);
      return this.#settlementForResult(job, result);
    } catch {
      return this.#retryOrFail(job, "scanner_error");
    }
  }

  #settlementForResult(job: DriveScanJob, result: VirusScanResult): DriveScanSettlement {
    const scan = result.securityScan;
    if (scan === undefined) {
      return this.#retryOrFail(job, "missing_scan_evidence");
    }
    if (scan.evidence.byteSize !== job.byteSize) {
      return this.#retryOrFail(job, "scan_byte_size_mismatch", scan);
    }
    if (scan.state === "clean" && result.disposition === "allow") {
      return { kind: "active", scan, disposition: "allow" };
    }
    if (result.disposition === "allow_unscanned") {
      return { kind: "active", scan, disposition: "allow_unscanned" };
    }
    if (scan.state === "infected" || scan.state === "unsupported") {
      return { kind: "quarantined", scan };
    }
    return this.#retryOrFail(job, "scan_failed", scan);
  }

  #retryOrFail(
    job: DriveScanJob,
    errorCode: string,
    scan?: SecurityScanResult,
  ): DriveScanSettlement {
    if (job.attempts < job.maxAttempts) {
      const exponent = Math.max(0, job.attempts - 1);
      const delay = Math.min(this.#options.retryBaseMs * 2 ** exponent, this.#options.retryMaxMs);
      return {
        kind: "retry",
        ...(scan === undefined ? {} : { scan }),
        errorCode,
        retryAt: new Date(Date.now() + delay),
      };
    }
    return {
      kind: "scan_failed",
      ...(scan === undefined ? {} : { scan }),
      errorCode,
    };
  }

  #runScheduledDrain(): Promise<DriveScanDrainResult> {
    if (this.#activeDrain !== undefined) return this.#activeDrain;
    this.#activeDrain = this.drainOnce()
      .catch((error: unknown) => {
        this.#options.onError?.(error);
        return emptyDrainResult();
      })
      .finally(() => {
        this.#activeDrain = undefined;
      });
    return this.#activeDrain;
  }
}

interface DriveScanJobRow {
  readonly id: string;
  readonly org_id: string;
  readonly object_id: string;
  readonly version_id: string;
  readonly requested_by_actor_id: string | null;
  readonly owner_actor_id: string | null;
  readonly storage_key: string;
  readonly byte_size: string | number;
  readonly sha256: string;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly upload_state: DriveUploadState;
  readonly deleted_at: Date | null;
}

export class PostgresDriveScanJobRepository implements DriveScanJobRepository {
  constructor(private readonly sql: postgres.Sql) {}

  async claim(input: {
    readonly workerId: string;
    readonly limit: number;
    readonly leaseMs: number;
  }): Promise<readonly DriveScanJob[]> {
    return this.sql.begin(async (tx) => {
      const rows = (await tx`
        with candidates as (
          select j.id
          from drive_scan_jobs j
          where j.attempts < j.max_attempts
            and (
              (
                j.status in ('pending', 'retry_scheduled')
                and j.available_at <= now()
              )
              or (
                j.status = 'running'
                and j.lease_expires_at < now()
              )
            )
          order by j.available_at asc, j.created_at asc
          limit ${input.limit}
          for update skip locked
        ),
        claimed as (
          update drive_scan_jobs j
          set
            status = 'running',
            attempts = attempts + 1,
            lease_owner = ${input.workerId},
            lease_expires_at = now() + (${input.leaseMs} * interval '1 millisecond'),
            updated_at = now()
          from candidates c
          where j.id = c.id
          returning j.*
        )
        select
          c.*,
          o.owner_actor_id,
          o.upload_state,
          o.deleted_at,
          v.storage_key,
          v.byte_size,
          v.sha256
        from claimed c
        join objects o on o.id = c.object_id and o.org_id = c.org_id
        join drive_versions v on v.id = c.version_id and v.object_id = c.object_id
      `) as unknown as readonly DriveScanJobRow[];
      for (const row of rows) {
        await tx`
          update objects
          set upload_state = 'scanning',
              metadata = metadata || '{"status":"scanning"}'::jsonb,
              updated_at = now()
          where id = ${row.object_id}
            and org_id = ${row.org_id}
            and upload_state in ('uploaded', 'scanning', 'scan_failed')
            and deleted_at is null
        `;
      }
      return rows.map(mapDriveScanJob);
    });
  }

  async settle(input: {
    readonly workerId: string;
    readonly job: DriveScanJob;
    readonly settlement: DriveScanSettlement;
  }): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const currentRows = (await tx`
        select
          j.id,
          j.status,
          j.lease_owner,
          o.upload_state,
          o.deleted_at,
          o.sha256,
          v.id as current_version_id
        from drive_scan_jobs j
        join objects o on o.id = j.object_id and o.org_id = j.org_id
        left join lateral (
          select id
          from drive_versions
          where object_id = o.id and org_id = o.org_id
          order by version_number desc
          limit 1
        ) v on true
        where j.id = ${input.job.id}
        for update of j, o
      `) as unknown as readonly {
        readonly id: string;
        readonly status: string;
        readonly lease_owner: string | null;
        readonly upload_state: DriveUploadState;
        readonly deleted_at: Date | null;
        readonly sha256: string | null;
        readonly current_version_id: string | null;
      }[];
      const current = currentRows[0];
      if (
        current === undefined ||
        current.status !== "running" ||
        current.lease_owner !== input.workerId
      ) {
        return false;
      }
      const stale =
        current.deleted_at !== null ||
        current.upload_state === "trashed" ||
        current.upload_state !== "scanning" ||
        current.sha256 !== input.job.sha256 ||
        current.current_version_id !== input.job.versionId;
      const settlement: DriveScanSettlement = stale
        ? { kind: "cancelled", errorCode: "stale_scan_result" }
        : input.settlement;
      await this.#persistSettlement(tx, input.workerId, input.job, settlement);
      return true;
    });
  }

  async #persistSettlement(
    tx: postgres.TransactionSql,
    workerId: string,
    job: DriveScanJob,
    settlement: DriveScanSettlement,
  ): Promise<void> {
    const evidence = settlement.kind === "cancelled" ? {} : (settlement.scan?.evidence ?? {});
    if (settlement.kind === "retry") {
      await tx`
        update drive_scan_jobs
        set status = 'retry_scheduled',
            available_at = ${settlement.retryAt},
            lease_owner = null,
            lease_expires_at = null,
            scan_evidence = ${tx.json(toJsonObject(evidence))},
            last_error_code = ${settlement.errorCode},
            updated_at = now()
        where id = ${job.id} and lease_owner = ${workerId} and status = 'running'
      `;
      return;
    }

    const jobStatus =
      settlement.kind === "cancelled"
        ? "cancelled"
        : settlement.kind === "scan_failed"
          ? "failed"
          : "completed";
    const objectState =
      settlement.kind === "active"
        ? "active"
        : settlement.kind === "quarantined"
          ? "quarantined"
          : settlement.kind === "scan_failed"
            ? "scan_failed"
            : null;
    const errorCode =
      settlement.kind === "active" || settlement.kind === "quarantined"
        ? null
        : settlement.errorCode;
    await tx`
      update drive_scan_jobs
      set status = ${jobStatus},
          lease_owner = null,
          lease_expires_at = null,
          scan_evidence = ${tx.json(toJsonObject(evidence))},
          last_error_code = ${errorCode},
          completed_at = now(),
          updated_at = now()
      where id = ${job.id} and lease_owner = ${workerId} and status = 'running'
    `;
    if (objectState === null) return;

    const scan =
      settlement.kind === "cancelled" || settlement.scan === undefined
        ? undefined
        : settlement.scan;
    const disposition = settlement.kind === "active" ? settlement.disposition : "quarantine";
    await tx`
      update objects
      set upload_state = ${objectState},
          metadata = metadata || ${tx.json(
            toJsonObject({
              status: objectState === "active" ? "ready" : objectState,
              ...(scan === undefined
                ? {}
                : {
                    malwareScan: {
                      state: scan.state,
                      disposition,
                      evidence: scan.evidence,
                    },
                  }),
            }),
          )}::jsonb,
          updated_at = now()
      where id = ${job.objectId}
        and org_id = ${job.orgId}
        and upload_state = 'scanning'
        and deleted_at is null
    `;
    const verb =
      settlement.kind === "active"
        ? settlement.scan.state === "clean"
          ? "drive.upload.activated"
          : "drive.upload.allowed_unscanned"
        : settlement.kind === "quarantined"
          ? "drive.upload.quarantined"
          : "drive.upload.scan_failed";
    await appendDriveActivity(tx, {
      orgId: job.orgId,
      actorId: job.requestedByActorId,
      verb,
      objectId: job.objectId,
      payload: {
        scanJobId: job.id,
        versionId: job.versionId,
        state: objectState,
        ...(scan === undefined ? {} : { scanState: scan.state }),
      },
    });
  }
}

export interface CreateDriveUploadScanWorkerOptions {
  readonly sql: postgres.Sql;
  readonly scanner: VirusScanner | undefined;
  readonly tier: SecurityTier;
  readonly storage?: DriveStorageClient;
  readonly storageResolver?: TenantStorageResolver;
  readonly concurrency?: number;
  readonly queueDepth?: number;
  readonly leaseMs?: number;
  readonly intervalMs?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly metrics?: SecurityScanningMetrics;
  readonly onError?: (error: unknown) => void;
}

/**
 * Boot integration boundary. Business boot fails here if a no-op scanner was
 * accidentally resolved, before any worker can publish unscanned content.
 */
export function createDriveUploadScanWorker(
  options: CreateDriveUploadScanWorkerOptions,
): DriveUploadScanWorker {
  assertDriveMalwareScannerReady(options.tier, options.scanner);
  if (options.scanner === undefined) {
    throw new Error("Drive scan worker requires a configured malware scanner.");
  }
  return new DriveUploadScanWorker({
    repository: new PostgresDriveScanJobRepository(options.sql),
    scanner: options.scanner,
    storageForOrg: async (orgId) => {
      const resolved = await options.storageResolver?.({ orgId });
      return resolved?.client ?? options.storage;
    },
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.queueDepth === undefined ? {} : { queueDepth: options.queueDepth }),
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    ...(options.retryBaseMs === undefined ? {} : { retryBaseMs: options.retryBaseMs }),
    ...(options.retryMaxMs === undefined ? {} : { retryMaxMs: options.retryMaxMs }),
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
}

function mapDriveScanJob(row: DriveScanJobRow): DriveScanJob {
  const requestedByActorId = row.requested_by_actor_id ?? row.owner_actor_id;
  if (requestedByActorId === null) {
    throw new Error("Drive scan job is missing its requesting actor.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    objectId: row.object_id,
    versionId: row.version_id,
    requestedByActorId,
    storageKey: row.storage_key,
    byteSize: typeof row.byte_size === "number" ? row.byte_size : Number(row.byte_size),
    sha256: row.sha256,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    uploadState: row.upload_state,
    deletedAt: row.deleted_at,
  };
}

function toJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${String(min)} and ${String(max)}.`);
  }
  return value;
}

function emptyDrainResult(): DriveScanDrainResult {
  return { claimed: 0, active: 0, quarantined: 0, retried: 0, failed: 0, cancelled: 0 };
}
