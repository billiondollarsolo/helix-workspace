import type postgres from "postgres";
import { withJobSpan } from "../observability/job-span.js";

export interface ChatRetentionStore {
  applyRetention(input: {
    readonly orgId: string;
    readonly actorId: "system";
    readonly now?: Date;
    readonly limit?: number;
  }): Promise<{ readonly tombstonedMessageIds: readonly string[] }>;
}

export interface ChatRetentionOrganizationSource {
  listOrganizationIds(limit: number): Promise<readonly string[]>;
}

export class PostgresChatRetentionOrganizationSource implements ChatRetentionOrganizationSource {
  constructor(private readonly sql: postgres.Sql) {}

  async listOrganizationIds(limit: number): Promise<readonly string[]> {
    const rows = (await this.sql`
      select distinct m.org_id
      from messages m
      where m.kind = 'chat' and m.deleted_at is null
      order by m.org_id
      limit ${limit}
    `) as unknown as readonly { readonly org_id: string }[];
    return rows.map((row) => row.org_id);
  }
}

export interface ChatRetentionRunResult {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly organizationsChecked: number;
  readonly tombstonedMessages: number;
  readonly saturatedOrganizations: readonly string[];
}

export interface ChatRetentionWorkerOptions {
  readonly store: ChatRetentionStore;
  readonly organizations: ChatRetentionOrganizationSource;
  readonly intervalMs?: number;
  readonly organizationLimit?: number;
  readonly batchSize?: number;
  readonly maxBatchesPerOrganization?: number;
  readonly now?: () => Date;
  readonly onResult?: (result: ChatRetentionRunResult) => void;
  readonly onError?: (error: unknown) => void;
}

const defaultIntervalMs = 60 * 60 * 1000;
const defaultOrganizationLimit = 1_000;
const defaultBatchSize = 500;
const defaultMaxBatchesPerOrganization = 10;

/** Leader-gated, bounded sweep that applies organization and room retention policy. */
export class ChatRetentionWorker {
  private readonly intervalMs: number;
  private readonly organizationLimit: number;
  private readonly batchSize: number;
  private readonly maxBatchesPerOrganization: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<ChatRetentionRunResult> | undefined;

  constructor(private readonly options: ChatRetentionWorkerOptions) {
    this.intervalMs = positiveInteger(options.intervalMs ?? defaultIntervalMs, "intervalMs");
    this.organizationLimit = positiveInteger(
      options.organizationLimit ?? defaultOrganizationLimit,
      "organizationLimit",
    );
    this.batchSize = positiveInteger(options.batchSize ?? defaultBatchSize, "batchSize");
    this.maxBatchesPerOrganization = positiveInteger(
      options.maxBatchesPerOrganization ?? defaultMaxBatchesPerOrganization,
      "maxBatchesPerOrganization",
    );
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.runScheduledSweep();
    }, this.intervalMs);
    this.timer.unref();
    void this.runScheduledSweep();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.activeRun;
  }

  async runOnce(): Promise<ChatRetentionRunResult> {
    return withJobSpan("chat-retention", async () => {
      const startedAt = this.now();
      const orgIds = await this.options.organizations.listOrganizationIds(this.organizationLimit);
      const saturatedOrganizations: string[] = [];
      let tombstonedMessages = 0;
      for (const orgId of orgIds) {
        let saturated = true;
        for (let batch = 0; batch < this.maxBatchesPerOrganization; batch += 1) {
          const result = await this.options.store.applyRetention({
            orgId,
            actorId: "system",
            now: startedAt,
            limit: this.batchSize,
          });
          tombstonedMessages += result.tombstonedMessageIds.length;
          if (result.tombstonedMessageIds.length < this.batchSize) {
            saturated = false;
            break;
          }
        }
        if (saturated) saturatedOrganizations.push(orgId);
      }
      return {
        startedAt: startedAt.toISOString(),
        completedAt: this.now().toISOString(),
        organizationsChecked: orgIds.length,
        tombstonedMessages,
        saturatedOrganizations,
      };
    });
  }

  private runScheduledSweep(): Promise<ChatRetentionRunResult> {
    if (this.activeRun !== undefined) return this.activeRun;
    const activeRun = this.runOnce()
      .then((result) => {
        this.options.onResult?.(result);
        return result;
      })
      .catch((error: unknown) => {
        this.options.onError?.(error);
        const now = this.now().toISOString();
        return {
          startedAt: now,
          completedAt: now,
          organizationsChecked: 0,
          tombstonedMessages: 0,
          saturatedOrganizations: [],
        } satisfies ChatRetentionRunResult;
      })
      .finally(() => {
        this.activeRun = undefined;
      });
    this.activeRun = activeRun;
    return activeRun;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}
