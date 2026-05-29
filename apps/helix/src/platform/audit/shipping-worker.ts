import type { ImmutableAuditActivityRecord, ImmutableAuditShipResult } from "./immutable-s3.js";

export interface AuditShippingCheckpoint {
  readonly id: string;
  readonly createdAt: string;
}

export interface AuditShippingBacklog {
  readonly recordCount: number;
  readonly oldestCreatedAt?: string;
}

export interface ListAuditShippingRecordsInput {
  readonly after: AuditShippingCheckpoint | null;
  readonly limit: number;
}

export interface AuditShippingStore {
  loadAuditShippingCheckpoint(destination: string): Promise<AuditShippingCheckpoint | null>;
  saveAuditShippingCheckpoint(destination: string, checkpoint: AuditShippingCheckpoint): Promise<void>;
  listAuditShippingRecords(
    input: ListAuditShippingRecordsInput,
  ): Promise<readonly ImmutableAuditActivityRecord[]>;
  getAuditShippingBacklog(after: AuditShippingCheckpoint | null): Promise<AuditShippingBacklog>;
}

export interface AuditBatchShipper {
  ship(records: readonly ImmutableAuditActivityRecord[]): Promise<ImmutableAuditShipResult>;
}

export interface AuditShippingRunResult {
  readonly destination: string;
  readonly status: "shipped" | "idle" | "error";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly shippedRecordCount: number;
  readonly checkpoint: AuditShippingCheckpoint | null;
  readonly backlog: AuditShippingBacklog;
  readonly lagSeconds: number;
  readonly error?: string;
}

export interface AuditShippingWorkerOptions {
  readonly store: AuditShippingStore;
  readonly shipper: AuditBatchShipper;
  readonly destination?: string;
  readonly batchSize?: number;
  readonly intervalMs?: number;
  readonly onResult?: (result: AuditShippingRunResult) => void;
  readonly onError?: (error: unknown) => void;
  readonly now?: () => Date;
}

const defaultDestination = "immutable-s3";
const defaultBatchSize = 500;
const defaultIntervalMs = 60_000;

export class AuditShippingWorker {
  private readonly destination: string;
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<AuditShippingRunResult> | undefined;

  constructor(private readonly options: AuditShippingWorkerOptions) {
    this.destination = options.destination ?? defaultDestination;
    this.batchSize = positiveInteger(options.batchSize ?? defaultBatchSize, "audit shipping batchSize");
    this.intervalMs = positiveInteger(options.intervalMs ?? defaultIntervalMs, "audit shipping intervalMs");
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }

    this.timer = setInterval(() => {
      void this.runScheduledShipping();
    }, this.intervalMs);
    void this.runScheduledShipping();
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

  async runOnce(): Promise<AuditShippingRunResult> {
    const startedAt = this.now();
    let checkpoint: AuditShippingCheckpoint | null = null;

    try {
      checkpoint = await this.options.store.loadAuditShippingCheckpoint(this.destination);
      const records = await this.options.store.listAuditShippingRecords({
        after: checkpoint,
        limit: this.batchSize,
      });

      if (records.length > 0) {
        const shippedRecordCount = await shipRecordsByOrg(this.options.shipper, records);
        checkpoint = checkpointFromRecord(lastRecord(records));
        await this.options.store.saveAuditShippingCheckpoint(this.destination, checkpoint);
        const backlog = await this.options.store.getAuditShippingBacklog(checkpoint);
        const completedAt = this.now();
        return {
          destination: this.destination,
          status: "shipped",
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          shippedRecordCount,
          checkpoint,
          backlog,
          lagSeconds: lagSecondsFor(backlog, completedAt, checkpoint.createdAt),
        };
      }

      const backlog = await this.options.store.getAuditShippingBacklog(checkpoint);
      const completedAt = this.now();
      return {
        destination: this.destination,
        status: "idle",
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        shippedRecordCount: 0,
        checkpoint,
        backlog,
        lagSeconds: lagSecondsFor(backlog, completedAt, checkpoint?.createdAt),
      };
    } catch (error) {
      const backlog = await safeBacklog(this.options.store, checkpoint);
      const completedAt = this.now();
      return {
        destination: this.destination,
        status: "error",
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        shippedRecordCount: 0,
        checkpoint,
        backlog,
        lagSeconds: lagSecondsFor(backlog, completedAt, checkpoint?.createdAt),
        error: errorMessage(error),
      };
    }
  }

  private runScheduledShipping(): Promise<AuditShippingRunResult> {
    if (this.activeRun !== undefined) {
      return this.activeRun;
    }

    const activeRun = this.runOnce()
      .then((result) => {
        this.options.onResult?.(result);
        if (result.status === "error") {
          this.options.onError?.(new Error(result.error ?? "Audit shipping failed"));
        }
        return result;
      })
      .finally(() => {
        this.activeRun = undefined;
      });

    this.activeRun = activeRun;
    return activeRun;
  }
}

async function shipRecordsByOrg(
  shipper: AuditBatchShipper,
  records: readonly ImmutableAuditActivityRecord[],
): Promise<number> {
  let shippedRecordCount = 0;
  for (const group of groupRecordsByOrg(records)) {
    const result = await shipper.ship(group);
    shippedRecordCount += result.recordCount;
  }
  return shippedRecordCount;
}

function groupRecordsByOrg(
  records: readonly ImmutableAuditActivityRecord[],
): readonly (readonly ImmutableAuditActivityRecord[])[] {
  const groups = new Map<string, ImmutableAuditActivityRecord[]>();
  for (const record of records) {
    const group = groups.get(record.orgId);
    if (group === undefined) {
      groups.set(record.orgId, [record]);
      continue;
    }
    group.push(record);
  }
  return [...groups.values()];
}

function checkpointFromRecord(record: ImmutableAuditActivityRecord): AuditShippingCheckpoint {
  return { id: record.id, createdAt: record.createdAt };
}

function lastRecord(records: readonly ImmutableAuditActivityRecord[]): ImmutableAuditActivityRecord {
  const record = records[records.length - 1];
  if (record === undefined) {
    throw new Error("Expected at least one audit shipping record.");
  }
  return record;
}

function lagSecondsFor(
  backlog: AuditShippingBacklog,
  now: Date,
  fallbackCreatedAt: string | undefined,
): number {
  const createdAt = backlog.oldestCreatedAt ?? fallbackCreatedAt;
  if (createdAt === undefined) {
    return 0;
  }
  return Math.max(0, Math.floor((now.getTime() - Date.parse(createdAt)) / 1_000));
}

async function safeBacklog(
  store: AuditShippingStore,
  checkpoint: AuditShippingCheckpoint | null,
): Promise<AuditShippingBacklog> {
  try {
    return await store.getAuditShippingBacklog(checkpoint);
  } catch {
    return { recordCount: 0 };
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
