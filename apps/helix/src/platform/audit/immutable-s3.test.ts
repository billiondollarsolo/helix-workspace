import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  MeteringClient,
  MeteringEmitInput,
  MeteringEvent,
  TraceContext,
} from "@helix/sdk";
import {
  ImmutableS3AuditShipper,
  shipImmutableAuditBatch,
  type ImmutableAuditActivityRecord,
  type ImmutableAuditObject,
  type ImmutableAuditObjectStore,
} from "./immutable-s3.js";

const now = () => new Date("2026-05-20T12:00:00.000Z");
const decoder = new TextDecoder();

describe("ImmutableS3AuditShipper", () => {
  it("ships audit records and a checksum manifest with object lock metadata", async () => {
    const store = new RecordingImmutableAuditStore();
    const result = await shipImmutableAuditBatch(
      {
        store,
        prefix: "helix-audit",
        retentionDays: 30,
        now,
        batchId: () => "batch-001",
      },
      [record("activity-1"), record("activity-2", { prevHash: digest("previous") })],
    );

    expect(result).toMatchObject({
      batchId: "batch-001",
      recordCount: 2,
      recordsKey: "helix-audit/2026/05/20/org-1/batch-001.ndjson",
      manifestKey: "helix-audit/2026/05/20/org-1/batch-001.manifest.json",
      objectLock: {
        mode: "COMPLIANCE",
        retainUntil: "2026-06-19T12:00:00.000Z",
      },
    });
    expect(store.objects).toHaveLength(2);

    const recordsObject = objectAt(store.objects, 0);
    const manifestObject = objectAt(store.objects, 1);
    expect(recordsObject).toMatchObject({
      key: result.recordsKey,
      contentType: "application/x-ndjson; charset=utf-8",
      metadata: {
        "helix-batch-id": "batch-001",
        "helix-kind": "audit-activity",
        "helix-manifest-key": result.manifestKey,
        "helix-record-count": "2",
        "helix-sha256": result.recordsSha256,
      },
      objectLock: result.objectLock,
    });
    expect(manifestObject).toMatchObject({
      key: result.manifestKey,
      contentType: "application/json; charset=utf-8",
      metadata: {
        "helix-kind": "audit-manifest",
        "helix-records-key": result.recordsKey,
        "helix-records-sha256": result.recordsSha256,
        "helix-sha256": result.manifestSha256,
      },
      objectLock: result.objectLock,
    });

    const lines = decoder.decode(recordsObject.body).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      actorId: "actor-1",
      id: "activity-1",
      orgId: "org-1",
      thisHash: digest("activity-1"),
      verb: "document.created",
    });
    expect(sha256Hex(recordsObject.body)).toBe(result.recordsSha256);

    const manifest: unknown = JSON.parse(decoder.decode(manifestObject.body));
    expect(manifest).toMatchObject({
      batchId: "batch-001",
      format: "helix.audit.immutable-s3.v1",
      hashChain: {
        firstPrevHash: null,
        lastThisHash: digest("activity-2"),
      },
      recordCount: 2,
      recordIds: ["activity-1", "activity-2"],
      recordsSha256: result.recordsSha256,
    });
    expect(sha256Hex(manifestObject.body)).toBe(result.manifestSha256);
  });

  it("emits privacy-safe storage metering after immutable audit objects are written", async () => {
    const store = new RecordingImmutableAuditStore();
    const metering = new RecordingMeteringClient();

    await shipImmutableAuditBatch(
      {
        store,
        metering,
        prefix: "helix-audit",
        now,
        batchId: () => "batch-001",
      },
      [record("activity-1"), record("activity-2")],
    );

    const byteDelta = store.objects.reduce((total, object) => total + object.body.byteLength, 0);
    expect(metering.records).toEqual([
      {
        orgId: "org-1",
        event: {
          type: "storage.delta",
          quantity: byteDelta,
          metadata: {
            bucket: "audit_immutable_s3",
            byte_delta: byteDelta,
          },
        },
      },
    ]);

    const metadataJson = JSON.stringify(metering.records[0]?.event.metadata);
    expect(metadataJson).not.toContain("helix-audit");
    expect(metadataJson).not.toContain("batch-001");
    expect(metadataJson).not.toContain("activity-1");
    expect(metadataJson).not.toContain("actor-1");
    expect(metadataJson).not.toContain("document.created");
    expect(metadataJson).not.toContain("doc-1");
    expect(metadataJson).not.toContain("127.0.0.1");
    expect(metadataJson).not.toContain(digest("activity-1"));
  });

  it("does not emit storage metering for mixed-org batches", async () => {
    const metering = new RecordingMeteringClient();

    await shipImmutableAuditBatch(
      {
        store: new RecordingImmutableAuditStore(),
        metering,
        now,
        batchId: () => "batch-001",
      },
      [record("activity-1"), record("activity-2", { orgId: "org-2" })],
    );

    expect(metering.records).toHaveLength(0);
  });

  it("does not emit storage metering when immutable object writes fail", async () => {
    const metering = new RecordingMeteringClient();

    await expect(
      shipImmutableAuditBatch(
        {
          store: new FailingImmutableAuditStore(),
          metering,
          now,
          batchId: () => "batch-001",
        },
        [record("activity-1")],
      ),
    ).rejects.toThrow("immutable store unavailable");

    expect(metering.records).toHaveLength(0);
  });

  it("buffers records and flushes when batchSize is reached", async () => {
    const store = new RecordingImmutableAuditStore();
    let batchNumber = 0;
    const shipper = new ImmutableS3AuditShipper({
      store,
      batchSize: 2,
      now,
      batchId: () => {
        batchNumber += 1;
        return `batch-${String(batchNumber)}`;
      },
    });

    await expect(shipper.append(record("activity-1"))).resolves.toBeNull();
    await expect(shipper.append(record("activity-2"))).resolves.toMatchObject({
      batchId: "batch-1",
      recordCount: 2,
    });
    await expect(shipper.flush()).resolves.toBeNull();

    expect(store.objects.map((object) => object.key)).toEqual([
      "audit/activity/2026/05/20/org-1/batch-1.ndjson",
      "audit/activity/2026/05/20/org-1/batch-1.manifest.json",
    ]);
  });

  it("rejects records without hash-chain material", async () => {
    const invalidRecord: ImmutableAuditActivityRecord = {
      ...record("activity-1"),
      thisHash: "not-a-digest",
    };

    await expect(shipImmutableAuditBatch({ store: new RecordingImmutableAuditStore() }, [invalidRecord])).rejects.toThrow(
      "thisHash must be a lowercase sha256 hex digest",
    );
  });
});

class RecordingImmutableAuditStore implements ImmutableAuditObjectStore {
  readonly objects: ImmutableAuditObject[] = [];

  async putObject(object: ImmutableAuditObject): Promise<void> {
    this.objects.push(object);
  }
}

class FailingImmutableAuditStore implements ImmutableAuditObjectStore {
  async putObject(): Promise<void> {
    throw new Error("immutable store unavailable");
  }
}

class RecordingMeteringClient implements MeteringClient {
  readonly records: {
    readonly orgId: string;
    readonly event: MeteringEvent;
    readonly trace?: TraceContext | undefined;
  }[] = [];

  async emit(orgId: string, event: MeteringEvent, trace?: TraceContext): Promise<void> {
    this.records.push({ orgId, event, ...(trace === undefined ? {} : { trace }) });
  }

  async emitBatch(events: readonly MeteringEmitInput[]): Promise<void> {
    for (const input of events) {
      await this.emit(input.orgId, input.event, input.trace);
    }
  }
}

function record(id: string, overrides: Partial<ImmutableAuditActivityRecord> = {}): ImmutableAuditActivityRecord {
  return {
    actorId: "actor-1",
    createdAt: "2026-05-20T11:59:00.000Z",
    id,
    metadata: { ip: "127.0.0.1" },
    objectId: "doc-1",
    objectType: "document",
    orgId: "org-1",
    thisHash: digest(id),
    verb: "document.created",
    ...overrides,
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function objectAt(objects: readonly ImmutableAuditObject[], index: number): ImmutableAuditObject {
  const object = objects[index];
  if (object === undefined) {
    throw new Error(`Expected object at index ${String(index)}`);
  }
  return object;
}
