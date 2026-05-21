import { describe, expect, it } from "vitest";
import { computeAuditHash, verifyAuditHashChain, type VerifiableAuditRecord } from "./hash.js";

describe("computeAuditHash", () => {
  it("canonicalizes metadata key order", () => {
    const left = computeAuditHash(
      {
        actorId: "actor-1",
        verb: "object.update",
        objectType: "object",
        metadata: { b: "2", a: "1" },
      },
      "previous",
    );
    const right = computeAuditHash(
      {
        actorId: "actor-1",
        verb: "object.update",
        objectType: "object",
        metadata: { a: "1", b: "2" },
      },
      "previous",
    );

    expect(left.thisHash).toEqual(right.thisHash);
  });

  it("links the previous hash into the next hash", () => {
    const base = {
      actorId: "actor-1",
      verb: "object.update",
      objectType: "object",
    };

    expect(computeAuditHash(base, "one").thisHash).not.toEqual(
      computeAuditHash(base, "two").thisHash,
    );
  });

  it("verifies a complete ordered hash chain", () => {
    const chain = buildChain([
      {
        actorId: "actor-1",
        id: "record-1",
        metadata: { subject: "Q3 launch" },
        objectType: "mail.thread",
        verb: "mail.thread.created",
      },
      {
        actorId: "actor-2",
        id: "record-2",
        metadata: { label: "priority" },
        objectId: "thread-1",
        objectType: "mail.thread",
        verb: "mail.label.applied",
      },
    ]);

    expect(verifyAuditHashChain(chain)).toEqual({
      checked: 2,
      failures: [],
      valid: true,
    });
  });

  it("reports a broken previous-hash link", () => {
    const chain = buildChain([
      {
        actorId: "actor-1",
        id: "record-1",
        objectType: "object",
        verb: "object.created",
      },
      {
        actorId: "actor-2",
        id: "record-2",
        objectType: "object",
        verb: "object.updated",
      },
    ]);
    const tampered: readonly VerifiableAuditRecord[] = [
      requireRecord(chain, 0),
      { ...requireRecord(chain, 1), prevHash: "wrong" },
    ];

    expect(verifyAuditHashChain(tampered)).toMatchObject({
      checked: 2,
      failures: [
        {
          actual: "wrong",
          id: "record-2",
          index: 1,
          reason: "prev_hash_mismatch",
        },
      ],
      valid: false,
    });
  });

  it("reports a record whose stored hash no longer matches its payload", () => {
    const chain = buildChain([
      {
        actorId: "actor-1",
        id: "record-1",
        metadata: { state: "before" },
        objectType: "object",
        verb: "object.updated",
      },
    ]);
    const tampered: readonly VerifiableAuditRecord[] = [
      { ...requireRecord(chain, 0), metadata: { state: "after" } },
    ];

    expect(verifyAuditHashChain(tampered)).toMatchObject({
      checked: 1,
      failures: [
        {
          id: "record-1",
          index: 0,
          reason: "this_hash_mismatch",
        },
      ],
      valid: false,
    });
  });

  it("treats an empty chain as valid", () => {
    expect(verifyAuditHashChain([])).toEqual({ checked: 0, failures: [], valid: true });
  });
});

function buildChain(
  records: readonly Omit<VerifiableAuditRecord, "prevHash" | "thisHash">[],
): readonly VerifiableAuditRecord[] {
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
  records: readonly VerifiableAuditRecord[],
  index: number,
): VerifiableAuditRecord {
  const record = records[index];
  if (record === undefined) {
    throw new Error(`Missing audit record at index ${String(index)}`);
  }
  return record;
}
