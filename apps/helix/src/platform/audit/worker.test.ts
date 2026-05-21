import { describe, expect, it, vi } from "vitest";
import { computeAuditHash } from "./hash.js";
import {
  AuditVerifierWorker,
  type AuditVerifierLease,
  type AuditVerifierLeaseHandle,
  type AuditVerifierStore,
} from "./worker.js";
import type { AuditVerificationRecord } from "./verifier.js";

describe("AuditVerifierWorker", () => {
  it("verifies every org and reports hash-chain failures", async () => {
    const orgARecords = buildChain([
      auditRecord("record-a-1", "2026-05-20T00:00:00.000Z", "object.created"),
    ]);
    const orgBRecords = buildChain([
      auditRecord("record-b-1", "2026-05-20T01:00:00.000Z", "object.created"),
      auditRecord("record-b-2", "2026-05-20T02:00:00.000Z", "object.updated"),
    ]);
    const store = new InMemoryAuditVerifierStore({
      "org-a": orgARecords,
      "org-b": [requireRecord(orgBRecords, 0), { ...requireRecord(orgBRecords, 1), prevHash: "bad" }],
    });
    const worker = new AuditVerifierWorker({
      store,
      now: fixedNow("2026-05-21T00:00:00.000Z"),
    });

    const result = await worker.runOnce();

    expect(result.status).toBe("completed");
    expect(result.checkedOrgCount).toBe(2);
    expect(result.verifiedOrgCount).toBe(1);
    expect(result.failedOrgCount).toBe(1);
    expect(result.results.map((entry) => [entry.orgId, entry.status])).toEqual([
      ["org-a", "verified"],
      ["org-b", "failed"],
    ]);
    expect(result.results[1]?.verification?.issues).toHaveLength(2);
    expect(store.listedOrgIds).toBe(1);
    expect(store.verifiedOrgIds).toEqual(["org-a", "org-b"]);
  });

  it("reports per-org verifier exceptions without aborting the daily run", async () => {
    const store = new InMemoryAuditVerifierStore({
      "org-a": buildChain([auditRecord("record-a-1", "2026-05-20T00:00:00.000Z", "object.created")]),
      "org-b": new Error("database read failed"),
    });
    const worker = new AuditVerifierWorker({
      store,
      now: fixedNow("2026-05-21T00:00:00.000Z"),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      status: "completed",
      checkedOrgCount: 2,
      verifiedOrgCount: 1,
      failedOrgCount: 1,
      results: [
        { orgId: "org-a", status: "verified" },
        { orgId: "org-b", status: "error", error: "database read failed" },
      ],
    });
  });

  it("skips when the optional leader lease is unavailable", async () => {
    const store = new InMemoryAuditVerifierStore({ "org-a": [] });
    const lease = new RecordingLease(false);
    const worker = new AuditVerifierWorker({
      store,
      lease,
      now: fixedNow("2026-05-21T00:00:00.000Z"),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      status: "skipped",
      skippedReason: "leader_lease_unavailable",
      checkedOrgCount: 0,
      verifiedOrgCount: 0,
      failedOrgCount: 0,
      results: [],
    });
    expect(lease.acquireCalls).toBe(1);
    expect(lease.releaseCalls).toBe(0);
    expect(store.listedOrgIds).toBe(0);
  });

  it("releases an acquired leader lease after verification", async () => {
    const lease = new RecordingLease(true);
    const worker = new AuditVerifierWorker({
      store: new InMemoryAuditVerifierStore({ "org-a": [] }),
      lease,
      now: fixedNow("2026-05-21T00:00:00.000Z"),
    });

    await worker.runOnce();

    expect(lease.acquireCalls).toBe(1);
    expect(lease.releaseCalls).toBe(1);
  });

  it("reports scheduled store errors through onError", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const onResult = vi.fn();
    const worker = new AuditVerifierWorker({
      store: new FailingAuditVerifierStore(),
      intervalMs: 1_000,
      onError,
      onResult,
      now: fixedNow("2026-05-21T00:00:00.000Z"),
    });

    try {
      worker.start();
      await vi.runOnlyPendingTimersAsync();
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "org listing failed" }));
    expect(onResult).not.toHaveBeenCalled();
  });
});

class InMemoryAuditVerifierStore implements AuditVerifierStore {
  listedOrgIds = 0;
  readonly verifiedOrgIds: string[] = [];

  constructor(
    private readonly recordsByOrg: Record<string, readonly AuditVerificationRecord[] | Error>,
  ) {}

  async listVerificationOrgIds(): Promise<readonly string[]> {
    this.listedOrgIds += 1;
    return Object.keys(this.recordsByOrg).sort();
  }

  async listVerificationRecords(input: {
    readonly orgId: string;
  }): Promise<readonly AuditVerificationRecord[]> {
    this.verifiedOrgIds.push(input.orgId);
    const records = this.recordsByOrg[input.orgId] ?? [];
    if (records instanceof Error) {
      throw records;
    }
    return records;
  }
}

class FailingAuditVerifierStore implements AuditVerifierStore {
  async listVerificationOrgIds(): Promise<readonly string[]> {
    throw new Error("org listing failed");
  }

  async listVerificationRecords(): Promise<readonly AuditVerificationRecord[]> {
    return [];
  }
}

class RecordingLease implements AuditVerifierLease {
  acquireCalls = 0;
  releaseCalls = 0;

  constructor(private readonly acquired: boolean) {}

  async tryAcquire(): Promise<AuditVerifierLeaseHandle | null> {
    this.acquireCalls += 1;
    if (!this.acquired) {
      return null;
    }
    return {
      release: async () => {
        this.releaseCalls += 1;
      },
    };
  }
}

function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

function auditRecord(
  id: string,
  createdAt: string,
  verb: string,
): Omit<AuditVerificationRecord, "prevHash" | "thisHash"> {
  return {
    id,
    actorId: "11111111-1111-4111-8111-111111111111",
    verb,
    objectType: "object",
    objectId: "33333333-3333-4333-8333-333333333333",
    metadata: { source: "test" },
    createdAt,
  };
}

function buildChain(
  records: readonly Omit<AuditVerificationRecord, "prevHash" | "thisHash">[],
): readonly AuditVerificationRecord[] {
  let previousHash: string | null = null;
  return records.map((record) => {
    const hash = computeAuditHash(record, previousHash);
    previousHash = hash.thisHash;
    return {
      ...record,
      prevHash: hash.prevHash,
      thisHash: hash.thisHash,
    };
  });
}

function requireRecord(
  records: readonly AuditVerificationRecord[],
  index: number,
): AuditVerificationRecord {
  const record = records[index];
  if (record === undefined) {
    throw new Error(`Missing audit verification record at index ${String(index)}`);
  }
  return record;
}
