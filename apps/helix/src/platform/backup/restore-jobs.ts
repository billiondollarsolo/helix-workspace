import { randomUUID } from "node:crypto";
import type { AuditRecord } from "@helix/sdk";
import type { Actor } from "@helix/sdk-types";
import type postgres from "postgres";
import type { BackupOperationResult, RestoreExecutor } from "./admin-routes.js";

export type RestoreJobStatus =
  "pending_approval" | "queued" | "processing" | "completed" | "cancelled" | "failed";

export interface RestoreJobRequest {
  readonly backupId: string;
  readonly encrypted: boolean;
  readonly targetDatabase: string;
  readonly targetObjectBucket: string;
  readonly idempotencyKey: string;
}

export interface RestoreJob {
  readonly id: string;
  readonly orgId: string;
  readonly requestedByActorId: string;
  readonly backupId: string;
  readonly encrypted: boolean;
  readonly targetDatabase: string;
  readonly targetObjectBucket: string;
  readonly status: RestoreJobStatus;
  readonly approvalCount: number;
  readonly attemptCount: number;
  readonly leaseToken?: string | undefined;
  readonly cancellationRequested: boolean;
  readonly lastError?: string | undefined;
  readonly result?: BackupOperationResult | undefined;
}

export interface RestoreJobStore {
  createJob(id: string, actor: Actor, input: RestoreJobRequest): Promise<RestoreJob>;
  getJob(id: string, orgId: string): Promise<RestoreJob | undefined>;
  approveJob(id: string, actor: Actor): Promise<RestoreJob | undefined>;
  cancelJob(id: string, orgId: string): Promise<RestoreJob | undefined>;
  claimJobs(input: {
    readonly owner: string;
    readonly limit: number;
    readonly leaseSeconds: number;
  }): Promise<readonly RestoreJob[]>;
  cancellationRequested(job: RestoreJob): Promise<boolean>;
  completeJob(job: RestoreJob, result: BackupOperationResult): Promise<void>;
  failJob(job: RestoreJob, error: string): Promise<void>;
  markCancelled(job: RestoreJob): Promise<void>;
}

interface RestoreJobRow {
  readonly id: string;
  readonly org_id: string;
  readonly requested_by_actor_id: string;
  readonly backup_id: string;
  readonly encrypted: boolean;
  readonly target_database: string;
  readonly target_object_bucket: string;
  readonly status: RestoreJobStatus;
  readonly approval_count: string;
  readonly attempt_count: number;
  readonly lease_token: string | null;
  readonly cancel_requested_at: Date | null;
  readonly last_error: string | null;
  readonly result: BackupOperationResult | null;
}

export class RestoreJobIdempotencyConflict extends Error {}

export class PostgresRestoreJobStore implements RestoreJobStore {
  constructor(private readonly sql: postgres.Sql) {}

  async createJob(id: string, actor: Actor, input: RestoreJobRequest): Promise<RestoreJob> {
    await this.sql`
      insert into backup_restore_jobs (
        id, org_id, requested_by_actor_id, idempotency_key, backup_id, encrypted,
        target_database, target_object_bucket
      ) values (
        ${id}, ${actor.orgId}, ${actor.id}, ${input.idempotencyKey}, ${input.backupId},
        ${input.encrypted}, ${input.targetDatabase}, ${input.targetObjectBucket}
      ) on conflict (org_id, requested_by_actor_id, idempotency_key) do nothing
    `;
    const job = await this.getByIdempotencyKey(actor.orgId, actor.id, input.idempotencyKey);
    if (job === undefined) throw new Error("Restore job was not created.");
    if (
      job.backupId !== input.backupId ||
      job.encrypted !== input.encrypted ||
      job.targetDatabase !== input.targetDatabase ||
      job.targetObjectBucket !== input.targetObjectBucket
    ) {
      throw new RestoreJobIdempotencyConflict(
        "Idempotency key was already used for another restore.",
      );
    }
    return job;
  }

  async getJob(id: string, orgId: string): Promise<RestoreJob | undefined> {
    const rows = await this.sql<RestoreJobRow[]>`
      select job.*, (select count(*)::text from backup_restore_job_approvals approval
        where approval.job_id = job.id) approval_count
      from backup_restore_jobs job where job.id = ${id} and job.org_id = ${orgId}
    `;
    return rows[0] === undefined ? undefined : mapJob(rows[0]);
  }

  async approveJob(id: string, actor: Actor): Promise<RestoreJob | undefined> {
    await this
      .sql`select * from helix_approve_backup_restore_job(${id}, ${actor.orgId}, ${actor.id})`;
    return this.getJob(id, actor.orgId);
  }

  async cancelJob(id: string, orgId: string): Promise<RestoreJob | undefined> {
    const rows = await this.sql<RestoreJobRow[]>`
      select changed.*, (select count(*)::text from backup_restore_job_approvals approval
        where approval.job_id = changed.id) approval_count
      from helix_cancel_backup_restore_job(${id}, ${orgId}) changed
    `;
    return rows[0] === undefined ? undefined : mapJob(rows[0]);
  }

  async claimJobs(input: {
    readonly owner: string;
    readonly limit: number;
    readonly leaseSeconds: number;
  }): Promise<readonly RestoreJob[]> {
    const rows = await this.sql<RestoreJobRow[]>`
      select claimed.*, (select count(*)::text from backup_restore_job_approvals approval
        where approval.job_id = claimed.id) approval_count
      from helix_claim_backup_restore_jobs(${input.owner}, ${input.limit}, ${input.leaseSeconds}) claimed
    `;
    return rows.map(mapJob);
  }

  async cancellationRequested(job: RestoreJob): Promise<boolean> {
    const rows = await this.sql<{ requested: boolean }[]>`
      select helix_backup_restore_cancel_requested(${job.id}, ${job.leaseToken ?? null}) requested
    `;
    return rows[0]?.requested === true;
  }

  async completeJob(job: RestoreJob, result: BackupOperationResult): Promise<void> {
    await this.sql`
      select helix_complete_backup_restore_job(
        ${job.id}, ${job.leaseToken ?? null},
        ${this.sql.json(toSqlJson(result))}
      )
    `;
  }

  async failJob(job: RestoreJob, error: string): Promise<void> {
    await this
      .sql`select helix_fail_backup_restore_job(${job.id}, ${job.leaseToken ?? null}, ${error})`;
  }

  async markCancelled(job: RestoreJob): Promise<void> {
    await this
      .sql`select helix_mark_backup_restore_job_cancelled(${job.id}, ${job.leaseToken ?? null})`;
  }

  private async getByIdempotencyKey(
    orgId: string,
    actorId: string,
    idempotencyKey: string,
  ): Promise<RestoreJob | undefined> {
    const rows = await this.sql<RestoreJobRow[]>`
      select job.*, (select count(*)::text from backup_restore_job_approvals approval
        where approval.job_id = job.id) approval_count
      from backup_restore_jobs job
      where job.org_id = ${orgId} and job.requested_by_actor_id = ${actorId}
        and job.idempotency_key = ${idempotencyKey}`;
    return rows[0] === undefined ? undefined : mapJob(rows[0]);
  }
}

function toSqlJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

export interface RestoreAuditSink {
  append(record: AuditRecord & { readonly orgId: string }): Promise<unknown>;
}

export interface RestoreJobWorkerOptions {
  readonly store: RestoreJobStore;
  readonly executor: RestoreExecutor;
  readonly auditSink: RestoreAuditSink;
  readonly owner?: string;
  readonly intervalMs?: number;
  readonly cancellationPollMs?: number;
  readonly onError?: (error: unknown) => void;
}

export class RestoreJobWorker {
  private readonly owner: string;
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<number> | undefined;

  constructor(private readonly options: RestoreJobWorkerOptions) {
    this.owner = options.owner ?? `backup-restore-${randomUUID()}`;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.runScheduled(), this.options.intervalMs ?? 1_000);
    void this.runScheduled();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }

  async drainOnce(): Promise<number> {
    const jobs = await this.options.store.claimJobs({
      owner: this.owner,
      limit: 1,
      leaseSeconds: 1200,
    });
    const job = jobs[0];
    if (job === undefined) return 0;
    await this.runJob(job);
    return 1;
  }

  private async runJob(job: RestoreJob): Promise<void> {
    const controller = new AbortController();
    let poller: NodeJS.Timeout | undefined;
    try {
      await this.audit(job, "backup.restore.execution_started");
      if (await this.options.store.cancellationRequested(job)) {
        await this.audit(job, "backup.restore.cancelled");
        await this.options.store.markCancelled(job);
        return;
      }
      poller = setInterval(() => {
        void this.options.store.cancellationRequested(job).then((requested) => {
          if (requested) controller.abort();
        }, this.options.onError);
      }, this.options.cancellationPollMs ?? 500);
      const result = await this.options.executor.restoreBackup({
        backupId: job.backupId,
        encrypted: job.encrypted,
        targetDatabase: job.targetDatabase,
        targetObjectBucket: job.targetObjectBucket,
        signal: controller.signal,
      });
      if (controller.signal.aborted || (await this.options.store.cancellationRequested(job))) {
        await this.audit(job, "backup.restore.cancelled");
        await this.options.store.markCancelled(job);
        return;
      }
      await this.audit(job, "backup.restore.completed");
      await this.options.store.completeJob(job, result);
    } catch (error) {
      if (controller.signal.aborted || (await this.options.store.cancellationRequested(job))) {
        await this.audit(job, "backup.restore.cancelled");
        await this.options.store.markCancelled(job);
      } else {
        await this.audit(job, "backup.restore.failed", { error: errorMessage(error) });
        await this.options.store.failJob(job, errorMessage(error));
        this.options.onError?.(error);
      }
    } finally {
      if (poller !== undefined) clearInterval(poller);
    }
  }

  private audit(
    job: RestoreJob,
    verb: string,
    extra: Record<string, string> = {},
  ): Promise<unknown> {
    return this.options.auditSink.append({
      orgId: job.orgId,
      actorId: job.requestedByActorId,
      verb,
      objectType: "backup_restore_job",
      objectId: job.id,
      metadata: {
        backupId: job.backupId,
        targetDatabase: job.targetDatabase,
        targetObjectBucket: job.targetObjectBucket,
        attemptCount: job.attemptCount,
        ...extra,
      },
    });
  }

  private runScheduled(): Promise<number> {
    if (this.active !== undefined) return this.active;
    this.active = this.drainOnce()
      .catch((error: unknown) => {
        this.options.onError?.(error);
        return 0;
      })
      .finally(() => {
        this.active = undefined;
      });
    return this.active;
  }
}

function mapJob(row: RestoreJobRow): RestoreJob {
  return {
    id: row.id,
    orgId: row.org_id,
    requestedByActorId: row.requested_by_actor_id,
    backupId: row.backup_id,
    encrypted: row.encrypted,
    targetDatabase: row.target_database,
    targetObjectBucket: row.target_object_bucket,
    status: row.status,
    approvalCount: Number(row.approval_count),
    attemptCount: row.attempt_count,
    ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }),
    cancellationRequested: row.cancel_requested_at !== null,
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    ...(row.result === null ? {} : { result: row.result }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
