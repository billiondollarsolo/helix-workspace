import type postgres from "postgres";
import {
  advisoryLockKey,
  LeaderElection,
  PostgresAdvisoryLockClient,
  type LeaderLease,
} from "../leader/election.js";
import {
  verifyLatestAuditHashChain,
  type AuditVerificationStore,
  type LatestAuditVerificationStatus,
} from "./verifier.js";

export interface AuditVerifierStore extends AuditVerificationStore {
  listVerificationOrgIds(): Promise<readonly string[]>;
}

export interface AuditVerifierLease {
  tryAcquire(): Promise<AuditVerifierLeaseHandle | null>;
}

export interface AuditVerifierLeaseHandle {
  release(): Promise<void>;
}

export type AuditVerifierOrgRunStatus = "verified" | "failed" | "error";

export interface AuditVerifierOrgRunResult {
  readonly orgId: string;
  readonly status: AuditVerifierOrgRunStatus;
  readonly verification?: LatestAuditVerificationStatus;
  readonly error?: string;
}

export interface AuditVerifierRunResult {
  readonly status: "completed" | "skipped";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly checkedOrgCount: number;
  readonly verifiedOrgCount: number;
  readonly failedOrgCount: number;
  readonly results: readonly AuditVerifierOrgRunResult[];
  readonly skippedReason?: "leader_lease_unavailable";
}

export interface AuditVerifierWorkerOptions {
  readonly store: AuditVerifierStore;
  readonly intervalMs?: number;
  readonly lease?: AuditVerifierLease;
  readonly onResult?: (result: AuditVerifierRunResult) => void;
  readonly onError?: (error: unknown) => void;
  readonly now?: () => Date;
}

const defaultDailyIntervalMs = 24 * 60 * 60 * 1_000;

export class AuditVerifierWorker {
  private readonly intervalMs: number;
  private readonly lease: AuditVerifierLease | undefined;
  private readonly onResult: ((result: AuditVerifierRunResult) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<AuditVerifierRunResult> | undefined;

  constructor(private readonly options: AuditVerifierWorkerOptions) {
    this.intervalMs = options.intervalMs ?? defaultDailyIntervalMs;
    this.lease = options.lease;
    this.onResult = options.onResult;
    this.onError = options.onError;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }

    this.timer = setInterval(() => {
      void this.runScheduledVerification();
    }, this.intervalMs);
    void this.runScheduledVerification();
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

  async runOnce(): Promise<AuditVerifierRunResult> {
    const startedAt = this.now();
    const handle = await this.lease?.tryAcquire();
    if (this.lease !== undefined && handle === null) {
      return {
        status: "skipped",
        skippedReason: "leader_lease_unavailable",
        startedAt: startedAt.toISOString(),
        completedAt: this.now().toISOString(),
        checkedOrgCount: 0,
        verifiedOrgCount: 0,
        failedOrgCount: 0,
        results: [],
      };
    }

    try {
      const orgIds = await this.options.store.listVerificationOrgIds();
      const results: AuditVerifierOrgRunResult[] = [];

      for (const orgId of orgIds) {
        try {
          const verification = await verifyLatestAuditHashChain(this.options.store, {
            orgId,
            now: this.now(),
          });
          results.push({
            orgId,
            status: verification.valid ? "verified" : "failed",
            verification,
          });
        } catch (error) {
          results.push({
            orgId,
            status: "error",
            error: errorMessage(error),
          });
        }
      }

      return {
        status: "completed",
        startedAt: startedAt.toISOString(),
        completedAt: this.now().toISOString(),
        checkedOrgCount: results.length,
        verifiedOrgCount: results.filter((result) => result.status === "verified").length,
        failedOrgCount: results.filter((result) => result.status !== "verified").length,
        results,
      };
    } finally {
      await handle?.release();
    }
  }

  private runScheduledVerification(): Promise<AuditVerifierRunResult> {
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
        const now = this.now().toISOString();
        const result: AuditVerifierRunResult = {
          status: "completed",
          startedAt: now,
          completedAt: now,
          checkedOrgCount: 0,
          verifiedOrgCount: 0,
          failedOrgCount: 1,
          results: [{ orgId: "", status: "error", error: errorMessage(error) }],
        };
        return result;
      })
      .finally(() => {
        this.activeRun = undefined;
      });

    this.activeRun = activeRun;
    return activeRun;
  }
}

export class PostgresAuditVerifierLease implements AuditVerifierLease {
  private readonly election: LeaderElection;

  constructor(
    sql: postgres.Sql,
    private readonly name = "audit-verifier-daily",
  ) {
    // The verifier acquires and releases the lock within a single brief run,
    // so a pooled (non-reserved) client is sufficient here.
    this.election = new LeaderElection(new PostgresAdvisoryLockClient(sql, { reserved: false }));
  }

  async tryAcquire(): Promise<AuditVerifierLeaseHandle | null> {
    const lease = await this.election.tryAcquire(this.name);
    return lease.acquired ? new PostgresAuditVerifierLeaseHandle(lease) : null;
  }
}

export function auditVerifierLeaseLockKey(name = "audit-verifier-daily"): bigint {
  return advisoryLockKey(name);
}

class PostgresAuditVerifierLeaseHandle implements AuditVerifierLeaseHandle {
  constructor(private readonly lease: LeaderLease) {}

  release(): Promise<void> {
    return this.lease.release();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
