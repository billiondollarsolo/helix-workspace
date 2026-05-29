import { createHash } from "node:crypto";
import type postgres from "postgres";

/**
 * Abstraction over a backend that can grant and release advisory locks.
 *
 * The Postgres implementation ({@link PostgresAdvisoryLockClient}) is the
 * production backend; tests provide in-memory fakes.
 */
export interface AdvisoryLockClient {
  tryAdvisoryLock(lockKey: bigint): Promise<boolean>;
  releaseAdvisoryLock(lockKey: bigint): Promise<void>;
}

export interface LeaderLease {
  readonly name: string;
  readonly lockKey: bigint;
  readonly acquired: boolean;
  release(): Promise<void>;
}

/**
 * Coordinates "only one replica may run this" semantics across a multi-replica
 * deployment using advisory locks. Consolidated single implementation — the
 * legacy `leader-election.ts` helper has been removed in favour of this class.
 */
export class LeaderElection {
  constructor(private readonly client: AdvisoryLockClient) {}

  async tryAcquire(name: string): Promise<LeaderLease> {
    const lockKey = advisoryLockKey(name);
    const acquired = await this.client.tryAdvisoryLock(lockKey);
    let released = false;

    return {
      name,
      lockKey,
      acquired,
      release: async () => {
        if (acquired && !released) {
          released = true;
          await this.client.releaseAdvisoryLock(lockKey);
        }
      },
    };
  }
}

/**
 * Derives a stable 64-bit advisory lock key from a human-readable lock name.
 */
export function advisoryLockKey(name: string): bigint {
  const digest = createHash("sha256").update(name).digest();
  return digest.readBigInt64BE(0);
}

/**
 * Postgres advisory-lock client.
 *
 * Postgres session-level advisory locks are bound to the connection that
 * acquired them. The `postgres` library pools connections, so a naive
 * `sql\`pg_try_advisory_lock(...)\`` followed later by `pg_advisory_unlock(...)`
 * can run on *different* connections — the unlock then silently no-ops and the
 * lock leaks. To hold a lock for the lifetime of a long-running singleton
 * worker we must pin a single reserved connection.
 *
 * Pass `{ reserved: true }` (the default) for long-lived leases; the client
 * reserves a dedicated connection on first acquire and releases it on
 * `releaseAdvisoryLock`. For short-lived, immediately-released locks the
 * pooled mode (`{ reserved: false }`) is acceptable.
 */
export class PostgresAdvisoryLockClient implements AdvisoryLockClient {
  private readonly reserved: boolean;
  private connection: postgres.ReservedSql | undefined;

  constructor(
    private readonly sql: postgres.Sql,
    options: { readonly reserved?: boolean } = {},
  ) {
    this.reserved = options.reserved ?? true;
  }

  async tryAdvisoryLock(lockKey: bigint): Promise<boolean> {
    const sql = await this.acquireConnection();
    try {
      const rows = await sql<{ readonly acquired: boolean }[]>`
        select pg_try_advisory_lock(${lockKey.toString()}::bigint) as acquired
      `;
      const acquired = rows[0]?.acquired ?? false;
      if (!acquired) {
        this.releaseConnection();
      }
      return acquired;
    } catch (error) {
      this.releaseConnection();
      throw error;
    }
  }

  async releaseAdvisoryLock(lockKey: bigint): Promise<void> {
    const sql = this.connection ?? this.sql;
    try {
      await sql`select pg_advisory_unlock(${lockKey.toString()}::bigint)`;
    } finally {
      this.releaseConnection();
    }
  }

  private async acquireConnection(): Promise<postgres.Sql> {
    if (!this.reserved) {
      return this.sql;
    }
    if (this.connection === undefined) {
      this.connection = await this.sql.reserve();
    }
    return this.connection;
  }

  private releaseConnection(): void {
    if (this.connection !== undefined) {
      this.connection.release();
      this.connection = undefined;
    }
  }
}

/**
 * A background worker with idempotent start/stop semantics. Every singleton
 * worker in the platform (outbox poller, webhook dispatcher, mail worker,
 * enrichment, indexer, audit verifier, pending-action expiry) satisfies this.
 */
export interface SupervisedWorker {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

export interface SingletonWorkerSupervisorOptions {
  /** Unique lock name for this worker. */
  readonly name: string;
  /** The worker to run only while this replica holds leadership. */
  readonly worker: SupervisedWorker;
  /** Leader election backed by the shared advisory-lock client. */
  readonly election: LeaderElection;
  /**
   * How often a non-leader replica retries acquisition so it can take over if
   * the current leader dies. Defaults to 15s. Set `0` to disable retries.
   */
  readonly retryIntervalMs?: number;
  readonly onLeadershipAcquired?: (name: string) => void;
  readonly onLeadershipSkipped?: (name: string) => void;
  readonly onError?: (error: unknown, name: string) => void;
}

const defaultRetryIntervalMs = 15_000;

/**
 * Wraps a singleton worker so it runs on exactly one replica at a time.
 *
 * On `start()` it attempts to acquire the named leader lease:
 *  - acquired  → starts the underlying worker and holds the lease.
 *  - not acquired → schedules periodic re-attempts; whichever replica next
 *    wins the lease (e.g. after the prior leader crashes) starts the worker.
 *
 * `stop()` stops the worker (if running) and releases the lease so another
 * replica can take over — this is what makes graceful shutdown failover-safe.
 */
export class SingletonWorkerSupervisor {
  private readonly retryIntervalMs: number;
  private lease: LeaderLease | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private started = false;
  private stopped = false;
  private workerRunning = false;

  constructor(private readonly options: SingletonWorkerSupervisorOptions) {
    this.retryIntervalMs = options.retryIntervalMs ?? defaultRetryIntervalMs;
  }

  /** True once this replica has won leadership and started the worker. */
  get isLeader(): boolean {
    return this.workerRunning;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.stopped = false;
    await this.attemptAcquire();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.started = false;
    if (this.retryTimer !== undefined) {
      clearInterval(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (this.workerRunning) {
      this.workerRunning = false;
      await this.options.worker.stop();
    }
    if (this.lease !== undefined) {
      const lease = this.lease;
      this.lease = undefined;
      await lease.release();
    }
  }

  /**
   * Reads the stop flag through a method so callers re-evaluate it after every
   * `await` — `stop()` can flip it concurrently while an acquire is in flight.
   */
  private isStopped(): boolean {
    return this.stopped;
  }

  private async attemptAcquire(): Promise<void> {
    if (this.isStopped() || this.workerRunning) {
      return;
    }
    try {
      const lease = await this.options.election.tryAcquire(this.options.name);
      if (this.isStopped()) {
        await lease.release();
        return;
      }
      if (lease.acquired) {
        this.lease = lease;
        this.workerRunning = true;
        this.stopRetryTimer();
        this.options.onLeadershipAcquired?.(this.options.name);
        // Fire-and-forget: a slow worker.start() must not block the rest of
        // Promise.all(supervisors.map(s => s.start())) in server bootstrap.
        // Errors from start() surface via onError; supervisors that never
        // finish start() simply leave workerRunning=true indefinitely (their
        // run loop runs in the background like any other worker).
        Promise.resolve()
          .then(() => this.options.worker.start())
          .catch((error: unknown) => {
            this.workerRunning = false;
            this.options.onError?.(error, this.options.name);
          });
      } else {
        this.options.onLeadershipSkipped?.(this.options.name);
        this.scheduleRetry();
      }
    } catch (error) {
      this.options.onError?.(error, this.options.name);
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.retryIntervalMs <= 0 || this.retryTimer !== undefined || this.stopped) {
      return;
    }
    this.retryTimer = setInterval(() => {
      void this.attemptAcquire();
    }, this.retryIntervalMs);
    this.retryTimer.unref();
  }

  private stopRetryTimer(): void {
    if (this.retryTimer !== undefined) {
      clearInterval(this.retryTimer);
      this.retryTimer = undefined;
    }
  }
}
