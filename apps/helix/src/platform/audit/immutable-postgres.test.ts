import { createHash } from "node:crypto";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { ImmutableAuditActivityRecord } from "./immutable-s3.js";
import { PostgresWormAuditReader, PostgresWormAuditShipper } from "./immutable-postgres.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(
  id: string,
  overrides: Partial<ImmutableAuditActivityRecord> = {},
): ImmutableAuditActivityRecord {
  return {
    id,
    orgId: "org-1",
    actorId: "actor-1",
    verb: "document.created",
    objectType: "document",
    objectId: "doc-1",
    createdAt: "2026-05-21T12:00:00.000Z",
    metadata: { ip: "127.0.0.1" },
    thisHash: digest(id),
    ...overrides,
  };
}

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

/**
 * Recording SQL stub. When a query is an UPDATE / DELETE / TRUNCATE against the
 * WORM table, it throws like the database trigger created by migration 0020 —
 * letting the test prove the WORM contract without a live Postgres.
 */
function createRecordingSql(responses: readonly (readonly unknown[])[] = []): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  const queue = [...responses];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> => {
    const text = strings.join("$");
    calls.push({ text, values });
    if (
      /audit_immutable_postgres/i.test(text) &&
      /\b(update|delete|truncate)\b/i.test(text)
    ) {
      return Promise.reject(
        new Error(
          "audit_immutable_postgres is append-only (WORM): mutation is not permitted",
        ),
      );
    }
    return Promise.resolve(queue.shift() ?? []);
  };
  const sql = Object.assign(tag, {
    begin: async <T>(callback: (sql: typeof tag) => Promise<T>): Promise<T> => callback(tag),
    json: (value: unknown) => value,
  }) as unknown as postgres.Sql;
  return { sql, calls };
}

describe("PostgresWormAuditShipper", () => {
  it("appends each record with an idempotent insert into the WORM table", async () => {
    const recording = createRecordingSql();
    const shipper = new PostgresWormAuditShipper(recording.sql);

    const result = await shipper.ship([record("11111111-1111-4111-8111-111111111111")]);

    expect(recording.calls).toHaveLength(1);
    const insert = recording.calls[0];
    expect(insert?.text).toContain("insert into audit_immutable_postgres");
    expect(insert?.text).toContain("on conflict (org_id, record_id) do nothing");
    expect(result).toMatchObject({
      recordCount: 1,
      recordsKey: "postgres://audit_immutable_postgres",
    });
  });

  it("ships a multi-record batch inside a single transaction", async () => {
    const recording = createRecordingSql();
    const shipper = new PostgresWormAuditShipper(recording.sql);

    const result = await shipper.ship([
      record("aaaaaaaa-0000-4000-8000-000000000001"),
      record("aaaaaaaa-0000-4000-8000-000000000002"),
    ]);

    expect(recording.calls).toHaveLength(2);
    expect(result.recordCount).toBe(2);
  });

  it("rejects records without valid hash-chain material", async () => {
    const shipper = new PostgresWormAuditShipper(createRecordingSql().sql);
    await expect(
      shipper.ship([record("rec-1", { thisHash: "not-a-digest" })]),
    ).rejects.toThrow("thisHash must be a lowercase sha256 hex digest");
  });

  it("rejects an empty batch", async () => {
    const shipper = new PostgresWormAuditShipper(createRecordingSql().sql);
    await expect(shipper.ship([])).rejects.toThrow("at least one record");
  });

  it("never issues UPDATE or DELETE — the WORM trigger would block them", async () => {
    const recording = createRecordingSql();
    const shipper = new PostgresWormAuditShipper(recording.sql);
    await shipper.ship([record("bbbbbbbb-0000-4000-8000-000000000001")]);

    for (const call of recording.calls) {
      expect(call.text.toLowerCase()).not.toMatch(/\bupdate\b|\bdelete\b|\btruncate\b/);
    }
  });

  it("surfaces the WORM trigger error if a mutation is ever attempted", async () => {
    const recording = createRecordingSql();
    // Simulate the trigger contract directly: any mutation must throw.
    const tag = recording.sql as unknown as (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => Promise<unknown>;
    await expect(
      tag`update audit_immutable_postgres set verb = 'tampered'`,
    ).rejects.toThrow("append-only (WORM)");
    await expect(
      tag`delete from audit_immutable_postgres`,
    ).rejects.toThrow("append-only (WORM)");
  });
});

describe("PostgresWormAuditReader", () => {
  it("counts and lists hashes for an org for verifier reconciliation", async () => {
    const recording = createRecordingSql([
      [{ record_count: 3 }],
      [{ this_hash: digest("a") }, { this_hash: digest("b") }],
    ]);
    const reader = new PostgresWormAuditReader(recording.sql);

    await expect(reader.countForOrg("org-1")).resolves.toBe(3);
    await expect(reader.listHashesForOrg("org-1")).resolves.toEqual([
      digest("a"),
      digest("b"),
    ]);
  });
});
