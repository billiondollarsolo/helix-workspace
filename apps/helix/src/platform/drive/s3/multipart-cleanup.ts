import type { StorageClient } from "@helix/sdk-types";
import type postgres from "postgres";
import type { SupervisedWorker } from "../../leader/election.js";
import { withTenantPostgresContext } from "../../tenancy/postgres-roles.js";
import type { DriveS3MultipartStore } from "./multipart-store.js";

/** Deletes staged part bytes; a missing object is already gone. */
export async function deleteStagedParts(
  storage: StorageClient,
  keys: readonly string[],
): Promise<void> {
  await Promise.all(keys.map((key) => storage.delete(key).catch(() => undefined)));
}

export interface DriveS3MultipartCleanupOptions {
  /** Tenant-aware SQL client; each org is cleaned inside its own RLS context. */
  readonly sql: postgres.Sql;
  readonly multipart: DriveS3MultipartStore;
  readonly resolveStorage: (orgId: string) => Promise<StorageClient | undefined>;
  readonly intervalMs: number;
  /** Expired uploads removed per org per run. */
  readonly batchSize: number;
  readonly onError?: (error: unknown) => void;
}

/**
 * Leader-gated sweep that aborts expired multipart uploads (7 days by default)
 * and deletes their staged bytes, so abandoned uploads cannot accumulate
 * between gateway requests.
 */
export class DriveS3MultipartCleanupWorker implements SupervisedWorker {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<number> | undefined;

  constructor(private readonly options: DriveS3MultipartCleanupOptions) {}

  async start(): Promise<void> {
    if (this.timer !== undefined) return;
    await this.runOnce().catch(() => undefined);
    this.timer = setInterval(
      () => void this.runOnce().catch(() => undefined),
      this.options.intervalMs,
    );
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.running?.catch(() => undefined);
  }

  /** Returns the number of uploads removed. */
  runOnce(): Promise<number> {
    if (this.running !== undefined) return this.running;
    const run = this.sweep()
      .catch((error: unknown) => {
        this.options.onError?.(error);
        throw error;
      })
      .finally(() => {
        this.running = undefined;
      });
    this.running = run;
    return run;
  }

  private async sweep(): Promise<number> {
    let removed = 0;
    let after = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const orgs = await this.options.sql<{ readonly id: string }[]>`
        select id from orgs where id > ${after}::uuid order by id limit 100
      `;
      for (const { id: orgId } of orgs) {
        try {
          removed += await this.sweepOrg(orgId);
        } catch (error) {
          this.options.onError?.(error);
        }
      }
      const last = orgs.at(-1);
      if (last === undefined || orgs.length < 100) return removed;
      after = last.id;
    }
  }

  private async sweepOrg(orgId: string): Promise<number> {
    const staged = await withTenantPostgresContext(this.options.sql, { orgId }, async () => {
      const expired = await this.options.multipart.listExpired({
        orgId,
        limit: this.options.batchSize,
      });
      const keys: string[] = [];
      for (const uploadId of expired) {
        keys.push(...(await this.options.multipart.remove({ orgId, uploadId })));
      }
      return { count: expired.length, keys };
    });
    if (staged.keys.length > 0) {
      const storage = await this.options.resolveStorage(orgId);
      if (storage !== undefined) await deleteStagedParts(storage, staged.keys);
    }
    return staged.count;
  }
}
