import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { computeAuditHash } from "./hash.js";
import { PostgresAuditStore } from "./store.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

describe("PostgresAuditStore", () => {
  it("hashes appended records with the same createdAt value stored in activity", async () => {
    const recording = createRecordingSql([[{ this_hash: "previous-hash" }], [{ id: "record-1" }]]);
    const store = new PostgresAuditStore(recording.sql);

    const result = await store.append({
      orgId: "22222222-2222-4222-8222-222222222222",
      actorId: "11111111-1111-4111-8111-111111111111",
      verb: "object.created",
      objectType: "object",
      objectId: "33333333-3333-4333-8333-333333333333",
      trace: { traceId: "trace-1" },
      metadata: { source: "test" },
    });

    const insert = recording.calls[1];
    const createdAt = insert?.values[9];
    expect(createdAt).toBeInstanceOf(Date);
    expect(insert?.text).toContain("created_at");
    expect(insert?.values[7]).toBe("previous-hash");
    expect(insert?.values[8]).toBe(
      computeAuditHash(
        {
          actorId: "11111111-1111-4111-8111-111111111111",
          verb: "object.created",
          objectType: "object",
          objectId: "33333333-3333-4333-8333-333333333333",
          trace: { traceId: "trace-1" },
          metadata: { source: "test" },
          createdAt: (createdAt as Date).toISOString(),
        },
        "previous-hash",
      ).thisHash,
    );
    expect(result).toEqual({ id: "record-1", thisHash: insert?.values[8] });
  });

  it("loads verification records in hash-chain order", async () => {
    const recording = createRecordingSql([
      [
        {
          id: "record-1",
          actor_id: "11111111-1111-4111-8111-111111111111",
          verb: "object.created",
          object_type: "object",
          object_id: null,
          trace_id: "trace-1",
          payload: { source: "test" },
          prev_hash: null,
          this_hash: "this-hash",
          created_at: new Date("2026-05-20T00:00:00.000Z"),
        },
      ],
    ]);
    const store = new PostgresAuditStore(recording.sql);

    const records = await store.listVerificationRecords({
      orgId: "22222222-2222-4222-8222-222222222222",
    });

    expect(recording.calls[0]?.text).toContain("order by created_at asc, id asc");
    expect(records).toEqual([
      {
        id: "record-1",
        actorId: "11111111-1111-4111-8111-111111111111",
        verb: "object.created",
        objectType: "object",
        trace: { traceId: "trace-1" },
        metadata: { source: "test" },
        prevHash: null,
        thisHash: "this-hash",
        createdAt: "2026-05-20T00:00:00.000Z",
      },
    ]);
  });

  it("lists orgs with audit activity for verification", async () => {
    const recording = createRecordingSql([
      [{ org_id: "org-a" }, { org_id: "org-b" }],
    ]);
    const store = new PostgresAuditStore(recording.sql);

    await expect(store.listVerificationOrgIds()).resolves.toEqual(["org-a", "org-b"]);
    expect(recording.calls[0]?.text).toContain("select distinct org_id");
    expect(recording.calls[0]?.text).toContain("order by org_id asc");
  });

  it("loads audit shipping records after a checkpoint and persists the next checkpoint", async () => {
    const checkpoint = {
      id: "00000000-0000-4000-8000-000000000001",
      createdAt: "2026-05-20T00:00:00.000Z",
    };
    const recording = createRecordingSql([
      [{ value: checkpoint }],
      [
        {
          id: "00000000-0000-4000-8000-000000000002",
          org_id: "22222222-2222-4222-8222-222222222222",
          actor_id: "11111111-1111-4111-8111-111111111111",
          verb: "object.created",
          object_type: "object",
          object_id: null,
          trace_id: "trace-1",
          payload: { source: "test" },
          prev_hash: null,
          this_hash: "this-hash",
          created_at: new Date("2026-05-20T00:01:00.000Z"),
        },
      ],
      [],
      [{ record_count: 7, oldest_created_at: new Date("2026-05-20T00:02:00.000Z") }],
    ]);
    const store = new PostgresAuditStore(recording.sql);

    await expect(store.loadAuditShippingCheckpoint("immutable-s3")).resolves.toEqual(checkpoint);
    await expect(
      store.listAuditShippingRecords({ after: checkpoint, limit: 10 }),
    ).resolves.toEqual([
      {
        id: "00000000-0000-4000-8000-000000000002",
        orgId: "22222222-2222-4222-8222-222222222222",
        actorId: "11111111-1111-4111-8111-111111111111",
        verb: "object.created",
        objectType: "object",
        trace: { traceId: "trace-1" },
        metadata: { source: "test" },
        prevHash: null,
        thisHash: "this-hash",
        createdAt: "2026-05-20T00:01:00.000Z",
      },
    ]);
    await store.saveAuditShippingCheckpoint("immutable-s3", {
      id: "00000000-0000-4000-8000-000000000002",
      createdAt: "2026-05-20T00:01:00.000Z",
    });
    await expect(store.getAuditShippingBacklog(checkpoint)).resolves.toEqual({
      recordCount: 7,
      oldestCreatedAt: "2026-05-20T00:02:00.000Z",
    });

    expect(recording.calls[0]?.text).toContain("from platform_config");
    expect(recording.calls[0]?.values).toContain("audit.shipping.immutable-s3.checkpoint");
    expect(recording.calls[1]?.text).toContain("order by created_at asc, id asc");
    expect(recording.calls[2]?.text).toContain("insert into platform_config");
    expect(recording.calls[3]?.text).toContain("count(*)::int as record_count");
  });
});

function createRecordingSql(responses: readonly (readonly unknown[])[]): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  const queue = [...responses];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("$"), values });
    return Promise.resolve(queue.shift() ?? []);
  };
  const sql = Object.assign(tag, {
    begin: async <T>(callback: (sql: typeof tag) => Promise<T>) => callback(tag),
    json: (value: unknown) => value,
  }) as unknown as postgres.Sql;
  return { sql, calls };
}
