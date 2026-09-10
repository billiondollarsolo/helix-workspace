import { describe, expect, it } from "vitest";
import { createRecordingSql } from "../../test-support/recording-sql.js";
import { PostgresAuditStore } from "./store.js";

describe("PostgresAuditStore", () => {
  it("returns the database-enforced audit hash", async () => {
    const recording = createRecordingSql(
      [[], [{ id: "record-1", this_hash: "database-hash" }]],
      "$",
    );
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

    expect(recording.calls[0]?.text).toContain("set_config('helix.org_id'");
    const insert = recording.calls[1];
    const createdAt = insert?.values[7];
    expect(createdAt).toBeInstanceOf(Date);
    expect(insert?.text).toContain("created_at");
    expect(insert?.text).toContain("returning id, this_hash");
    expect(result).toEqual({ id: "record-1", thisHash: "database-hash" });
  });

  it("loads verification records in hash-chain order", async () => {
    const recording = createRecordingSql(
      [
        [],
        [
          {
            id: "record-1",
            org_id: "22222222-2222-4222-8222-222222222222",
            actor_id: "11111111-1111-4111-8111-111111111111",
            verb: "object.created",
            object_type: "object",
            object_id: null,
            trace_id: "trace-1",
            payload: { source: "test" },
            prev_hash: null,
            this_hash: "this-hash",
            created_at: new Date("2026-05-20T00:00:00.000Z"),
            schema_version: 1,
            sequence: "1",
          },
        ],
      ],
      "$",
    );
    const store = new PostgresAuditStore(recording.sql);

    const records = await store.listVerificationRecords({
      orgId: "22222222-2222-4222-8222-222222222222",
    });

    expect(recording.calls[0]?.text).toContain("set_config('helix.org_id'");
    expect(recording.calls[1]?.text).toContain("order by activity.sequence asc");
    expect(records).toEqual([
      {
        id: "record-1",
        orgId: "22222222-2222-4222-8222-222222222222",
        actorId: "11111111-1111-4111-8111-111111111111",
        verb: "object.created",
        objectType: "object",
        trace: { traceId: "trace-1" },
        metadata: { source: "test" },
        prevHash: null,
        thisHash: "this-hash",
        createdAt: "2026-05-20T00:00:00.000Z",
        schemaVersion: 1,
        sequence: "1",
      },
    ]);
  });

  it("lists orgs with audit activity for verification", async () => {
    const recording = createRecordingSql([[{ org_id: "org-a" }, { org_id: "org-b" }]], "$");
    const store = new PostgresAuditStore(recording.sql);

    await expect(store.listVerificationOrgIds()).resolves.toEqual(["org-a", "org-b"]);
    expect(recording.calls[0]?.text).toContain("helix_list_audit_org_ids()");
  });

  it("loads audit shipping records after a checkpoint and persists the next checkpoint", async () => {
    const checkpoint = {
      id: "00000000-0000-4000-8000-000000000001",
      createdAt: "2026-05-20T00:00:00.000Z",
    };
    const recording = createRecordingSql(
      [
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
      ],
      "$",
    );
    const store = new PostgresAuditStore(recording.sql);

    await expect(store.loadAuditShippingCheckpoint("immutable-s3")).resolves.toEqual(checkpoint);
    await expect(store.listAuditShippingRecords({ after: checkpoint, limit: 10 })).resolves.toEqual(
      [
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
      ],
    );
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
    expect(recording.calls[1]?.text).toContain("helix_list_audit_shipping_records");
    expect(recording.calls[2]?.text).toContain("insert into platform_config");
    expect(recording.calls[3]?.text).toContain("helix_get_audit_shipping_backlog");
  });
});
