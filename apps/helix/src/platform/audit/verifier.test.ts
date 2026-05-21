import { describe, expect, it } from "vitest";
import { computeAuditHash } from "./hash.js";
import {
  verifyAuditHashChain,
  verifyLatestAuditHashChain,
  type AuditVerificationRecord,
  type AuditVerificationStore,
} from "./verifier.js";

const orgId = "22222222-2222-4222-8222-222222222222";

describe("audit hash-chain verifier", () => {
  it("reports latest offline verification status for an org", async () => {
    const records = buildChain([
      auditRecord("record-1", "2026-05-19T23:58:00.000Z", "object.created"),
      auditRecord("record-2", "2026-05-20T00:02:00.000Z", "object.updated"),
    ]);
    const store = new InMemoryAuditVerificationStore(records);

    const status = await verifyLatestAuditHashChain(store, {
      orgId,
      now: new Date("2026-05-20T08:00:00.000Z"),
    });

    expect(status).toEqual({
      orgId,
      verifiedAt: "2026-05-20T08:00:00.000Z",
      valid: true,
      checkedRecordCount: 2,
      issues: [],
      lastHash: records[1]?.thisHash,
      latestRecordId: "record-2",
      latestRecordCreatedAt: "2026-05-20T00:02:00.000Z",
    });
    expect(store.calls).toEqual([{ orgId }]);
  });

  it("includes hash-chain failures in latest status", async () => {
    const records = buildChain([
      auditRecord("record-1", "2026-05-20T00:00:00.000Z", "object.created"),
      auditRecord("record-2", "2026-05-20T00:05:00.000Z", "object.updated"),
    ]);
    const tampered = [
      requireRecord(records, 0),
      { ...requireRecord(records, 1), prevHash: "wrong" },
    ];

    const status = await verifyLatestAuditHashChain(new InMemoryAuditVerificationStore(tampered), {
      orgId,
      now: new Date("2026-05-20T08:00:00.000Z"),
    });

    expect(status.valid).toBe(false);
    expect(status.checkedRecordCount).toBe(2);
    expect(status.latestRecordId).toBe("record-2");
    expect(status.issues).toEqual([
      {
        code: "prev_hash_mismatch",
        index: 1,
        id: "record-2",
        expected: records[0]?.thisHash,
        actual: "wrong",
      },
      {
        code: "this_hash_mismatch",
        index: 1,
        id: "record-2",
        expected: computeAuditHash(requireRecord(tampered, 1), "wrong").thisHash,
        actual: records[1]?.thisHash,
      },
    ]);
  });

  it("treats an empty org chain as a successful verification", async () => {
    const status = await verifyLatestAuditHashChain(new InMemoryAuditVerificationStore([]), {
      orgId,
      now: new Date("2026-05-20T08:00:00.000Z"),
    });

    expect(status).toEqual({
      orgId,
      verifiedAt: "2026-05-20T08:00:00.000Z",
      valid: true,
      checkedRecordCount: 0,
      issues: [],
      lastHash: null,
      latestRecordId: null,
      latestRecordCreatedAt: null,
    });
  });

  it("accepts an initial previous hash for partial offline windows", () => {
    const records = buildChain([
      auditRecord("record-1", "2026-05-20T00:00:00.000Z", "object.created"),
      auditRecord("record-2", "2026-05-20T00:05:00.000Z", "object.updated"),
    ]);

    expect(verifyAuditHashChain([requireRecord(records, 1)], records[0]?.thisHash ?? null)).toEqual(
      {
        valid: true,
        checkedRecordCount: 1,
        issues: [],
        lastHash: records[1]?.thisHash,
      },
    );
  });
});

class InMemoryAuditVerificationStore implements AuditVerificationStore {
  readonly calls: { readonly orgId: string }[] = [];

  constructor(private readonly records: readonly AuditVerificationRecord[]) {}

  async listVerificationRecords(input: {
    readonly orgId: string;
  }): Promise<readonly AuditVerificationRecord[]> {
    this.calls.push(input);
    return this.records;
  }
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
