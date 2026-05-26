import { describe, expect, it, vi } from "vitest";
import type { ImmutableAuditActivityRecord, ImmutableAuditShipResult } from "./immutable-s3.js";
import {
  AuditShippingWorker,
  type AuditBatchShipper,
  type AuditShippingBacklog,
  type AuditShippingCheckpoint,
  type AuditShippingStore,
} from "./shipping-worker.js";

describe("AuditShippingWorker", () => {
  it("ships the next audit page and checkpoints only after a successful batch write", async () => {
    const records = [
      auditRecord("00000000-0000-4000-8000-000000000001", "2026-05-20T00:00:00.000Z"),
      auditRecord("00000000-0000-4000-8000-000000000002", "2026-05-20T00:01:00.000Z"),
    ];
    const store = new InMemoryAuditShippingStore(records, {
      recordCount: 0,
    });
    const shipper = new RecordingAuditBatchShipper();
    const worker = new AuditShippingWorker({
      store,
      shipper,
      batchSize: 2,
      now: fixedNow("2026-05-20T00:02:00.000Z"),
    });

    const result = await worker.runOnce();

    expect(result).toMatchObject({
      destination: "immutable-s3",
      status: "shipped",
      shippedRecordCount: 2,
      checkpoint: {
        id: "00000000-0000-4000-8000-000000000002",
        createdAt: "2026-05-20T00:01:00.000Z",
      },
      backlog: { recordCount: 0 },
      lagSeconds: 60,
    });
    expect(shipper.shippedIds).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
    expect(shipper.shippedGroups).toEqual([
      ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"],
    ]);
    expect(store.savedCheckpoints).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000002",
        createdAt: "2026-05-20T00:01:00.000Z",
      },
    ]);
  });

  it("does not advance the checkpoint when shipping fails", async () => {
    const store = new InMemoryAuditShippingStore([
      auditRecord("00000000-0000-4000-8000-000000000001", "2026-05-20T00:00:00.000Z"),
    ]);
    const worker = new AuditShippingWorker({
      store,
      shipper: new FailingAuditBatchShipper(),
      now: fixedNow("2026-05-20T00:02:00.000Z"),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      status: "error",
      error: "S3 object lock rejected the write",
      shippedRecordCount: 0,
      checkpoint: null,
      backlog: { recordCount: 1, oldestCreatedAt: "2026-05-20T00:00:00.000Z" },
      lagSeconds: 120,
    });
    expect(store.savedCheckpoints).toEqual([]);
  });

  it("reports a recoverable error when checkpoint loading fails", async () => {
    const store = new FailingCheckpointAuditShippingStore();
    const worker = new AuditShippingWorker({
      store,
      shipper: new RecordingAuditBatchShipper(),
      now: fixedNow("2026-05-20T00:02:00.000Z"),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      status: "error",
      error: "platform_config is unavailable",
      shippedRecordCount: 0,
      checkpoint: null,
      backlog: { recordCount: 0 },
      lagSeconds: 0,
    });
  });

  it("reports idle backlog and avoids overlapping scheduled runs", async () => {
    vi.useFakeTimers();
    const onResult = vi.fn();
    const store = new BlockingAuditShippingStore();
    const worker = new AuditShippingWorker({
      store,
      shipper: new RecordingAuditBatchShipper(),
      intervalMs: 1_000,
      onResult,
      now: fixedNow("2026-05-20T00:02:00.000Z"),
    });

    try {
      worker.start();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(store.listCalls).toBe(1);
      store.release();
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "idle",
        backlog: { recordCount: 0 },
      }),
    );
  });

  it("ships mixed-org pages as contiguous org-scoped batches before checkpointing", async () => {
    const records = [
      auditRecord("00000000-0000-4000-8000-000000000001", "2026-05-20T00:00:00.000Z", {
        orgId: "org-a",
      }),
      auditRecord("00000000-0000-4000-8000-000000000002", "2026-05-20T00:01:00.000Z", {
        orgId: "org-a",
      }),
      auditRecord("00000000-0000-4000-8000-000000000003", "2026-05-20T00:02:00.000Z", {
        orgId: "org-b",
      }),
      auditRecord("00000000-0000-4000-8000-000000000004", "2026-05-20T00:03:00.000Z", {
        orgId: "org-a",
      }),
    ];
    const store = new InMemoryAuditShippingStore(records, { recordCount: 0 });
    const shipper = new RecordingAuditBatchShipper();
    const worker = new AuditShippingWorker({
      store,
      shipper,
      batchSize: 10,
      now: fixedNow("2026-05-20T00:04:00.000Z"),
    });

    const result = await worker.runOnce();

    expect(result).toMatchObject({
      status: "shipped",
      shippedRecordCount: 4,
      checkpoint: {
        id: "00000000-0000-4000-8000-000000000004",
        createdAt: "2026-05-20T00:03:00.000Z",
      },
    });
    expect(shipper.shippedGroups).toEqual([
      ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"],
      ["00000000-0000-4000-8000-000000000003"],
      ["00000000-0000-4000-8000-000000000004"],
    ]);
    expect(store.savedCheckpoints).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000004",
        createdAt: "2026-05-20T00:03:00.000Z",
      },
    ]);
  });
});

class InMemoryAuditShippingStore implements AuditShippingStore {
  readonly savedCheckpoints: AuditShippingCheckpoint[] = [];
  private checkpoint: AuditShippingCheckpoint | null = null;

  constructor(
    private readonly records: readonly ImmutableAuditActivityRecord[],
    private readonly backlog?: AuditShippingBacklog,
  ) {}

  async loadAuditShippingCheckpoint(): Promise<AuditShippingCheckpoint | null> {
    return this.checkpoint;
  }

  async saveAuditShippingCheckpoint(
    _destination: string,
    checkpoint: AuditShippingCheckpoint,
  ): Promise<void> {
    this.savedCheckpoints.push(checkpoint);
    this.checkpoint = checkpoint;
  }

  async listAuditShippingRecords(): Promise<readonly ImmutableAuditActivityRecord[]> {
    return this.records;
  }

  async getAuditShippingBacklog(): Promise<AuditShippingBacklog> {
    return (
      this.backlog ?? {
        recordCount: this.records.length,
        ...(this.records[0] === undefined ? {} : { oldestCreatedAt: this.records[0].createdAt }),
      }
    );
  }
}

class BlockingAuditShippingStore implements AuditShippingStore {
  listCalls = 0;
  private releaseList: (() => void) | undefined;

  async loadAuditShippingCheckpoint(): Promise<AuditShippingCheckpoint | null> {
    return null;
  }

  async saveAuditShippingCheckpoint(): Promise<void> {}

  async listAuditShippingRecords(): Promise<readonly ImmutableAuditActivityRecord[]> {
    this.listCalls += 1;
    await new Promise<void>((resolve) => {
      this.releaseList = resolve;
    });
    return [];
  }

  async getAuditShippingBacklog(): Promise<AuditShippingBacklog> {
    return { recordCount: 0 };
  }

  release(): void {
    this.releaseList?.();
  }
}

class FailingCheckpointAuditShippingStore implements AuditShippingStore {
  async loadAuditShippingCheckpoint(): Promise<AuditShippingCheckpoint | null> {
    throw new Error("platform_config is unavailable");
  }

  async saveAuditShippingCheckpoint(): Promise<void> {}

  async listAuditShippingRecords(): Promise<readonly ImmutableAuditActivityRecord[]> {
    throw new Error("records should not load");
  }

  async getAuditShippingBacklog(): Promise<AuditShippingBacklog> {
    throw new Error("backlog should fall back");
  }
}

class RecordingAuditBatchShipper implements AuditBatchShipper {
  readonly shippedIds: string[] = [];
  readonly shippedGroups: string[][] = [];

  async ship(records: readonly ImmutableAuditActivityRecord[]): Promise<ImmutableAuditShipResult> {
    this.shippedGroups.push(records.map((record) => record.id));
    this.shippedIds.push(...records.map((record) => record.id));
    return {
      batchId: "batch-1",
      recordCount: records.length,
      recordsKey: "audit/batch-1.ndjson",
      recordsSha256: "a".repeat(64),
      manifestKey: "audit/batch-1.manifest.json",
      manifestSha256: "b".repeat(64),
    };
  }
}

class FailingAuditBatchShipper implements AuditBatchShipper {
  async ship(): Promise<ImmutableAuditShipResult> {
    throw new Error("S3 object lock rejected the write");
  }
}

function auditRecord(
  id: string,
  createdAt: string,
  overrides: Partial<ImmutableAuditActivityRecord> = {},
): ImmutableAuditActivityRecord {
  return {
    id,
    orgId: "22222222-2222-4222-8222-222222222222",
    actorId: "11111111-1111-4111-8111-111111111111",
    verb: "object.created",
    objectType: "object",
    metadata: {},
    thisHash: "c".repeat(64),
    createdAt,
    ...overrides,
  };
}

function fixedNow(value: string): () => Date {
  return () => new Date(value);
}
