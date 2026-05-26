import type postgres from "postgres";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { StorageClient } from "@helix/sdk";
import { auditDestinationKinds, createAuditDestinationShipper } from "./destinations.js";
import { SiemAuditShipper } from "./siem-syslog.js";
import { PostgresWormAuditShipper } from "./immutable-postgres.js";
import type { ImmutableAuditActivityRecord } from "./immutable-s3.js";

function fakeStorage(): StorageClient {
  return {
    put: async () => undefined,
  } as unknown as StorageClient;
}

class RecordingStorageClient implements StorageClient {
  readonly puts: { readonly key: string; readonly body: Uint8Array }[] = [];

  async put(object: { readonly key: string; readonly body: Uint8Array }): Promise<void> {
    this.puts.push(object);
  }

  async get(): Promise<null> {
    return null;
  }

  async delete(): Promise<void> {}
}

function fakeSql(): postgres.Sql {
  const tag = (): Promise<unknown> => Promise.resolve([]);
  return Object.assign(tag, {
    begin: async <T>(cb: (sql: typeof tag) => Promise<T>): Promise<T> => cb(tag),
    json: (value: unknown) => value,
  }) as unknown as postgres.Sql;
}

describe("createAuditDestinationShipper", () => {
  it("exposes all three production audit destinations", () => {
    expect(auditDestinationKinds).toEqual([
      "immutable-s3",
      "siem-syslog",
      "audit-immutable-postgres",
    ]);
  });

  it("builds an immutable-s3 batch shipper", () => {
    const shipper = createAuditDestinationShipper({
      destination: "immutable-s3",
      storage: fakeStorage(),
      prefix: "helix-audit",
    });
    expect(typeof shipper.ship).toBe("function");
  });

  it("routes immutable-s3 batches through tenant-resolved storage", async () => {
    const configuredStorage = new RecordingStorageClient();
    const tenantStorage = new RecordingStorageClient();
    const shipper = createAuditDestinationShipper(
      {
        destination: "immutable-s3",
        storage: configuredStorage,
        prefix: "helix-audit",
      },
      {
        tenantStorageResolver: async ({ orgId }) => ({
          client: tenantStorage,
          managedBy: orgId === "org-1" ? "byo" : "helix-default",
          prefix: "tenant-prefix",
        }),
      },
    );

    const result = await shipper.ship([record("activity-1")]);

    expect(result.recordCount).toBe(1);
    expect(configuredStorage.puts).toEqual([]);
    expect(tenantStorage.puts.map((put) => put.key)).toEqual([
      expect.stringMatching(/^helix-audit\/\d{4}\/\d{2}\/\d{2}\/org-1\/.+\.ndjson$/u),
      expect.stringMatching(/^helix-audit\/\d{4}\/\d{2}\/\d{2}\/org-1\/.+\.manifest\.json$/u),
    ]);
  });

  it("rejects direct immutable-s3 tenant-resolved mixed-org batches", async () => {
    const shipper = createAuditDestinationShipper(
      {
        destination: "immutable-s3",
        storage: fakeStorage(),
      },
      {
        tenantStorageResolver: async () => ({
          client: fakeStorage(),
          managedBy: "helix-default",
          prefix: "",
        }),
      },
    );

    await expect(
      shipper.ship([
        record("activity-1", { orgId: "org-1" }),
        record("activity-2", { orgId: "org-2" }),
      ]),
    ).rejects.toThrow("requires records from a single org");
  });

  it("builds a SIEM syslog shipper", () => {
    const shipper = createAuditDestinationShipper({
      destination: "siem-syslog",
      host: "siem.example.com",
      port: 6514,
      transport: "tls",
      format: "cef",
    });
    expect(shipper).toBeInstanceOf(SiemAuditShipper);
  });

  it("builds a WORM Postgres shipper when a sql client is supplied", () => {
    const shipper = createAuditDestinationShipper(
      { destination: "audit-immutable-postgres" },
      { sql: fakeSql() },
    );
    expect(shipper).toBeInstanceOf(PostgresWormAuditShipper);
  });

  it("rejects the WORM Postgres destination without a sql client", () => {
    expect(() =>
      createAuditDestinationShipper({ destination: "audit-immutable-postgres" }),
    ).toThrow("requires a Postgres client");
  });
});

function record(
  id: string,
  overrides: Partial<ImmutableAuditActivityRecord> = {},
): ImmutableAuditActivityRecord {
  return {
    actorId: "actor-1",
    createdAt: "2026-05-20T11:59:00.000Z",
    id,
    metadata: {},
    objectId: "doc-1",
    objectType: "document",
    orgId: "org-1",
    thisHash: createHash("sha256").update(id).digest("hex"),
    verb: "document.created",
    ...overrides,
  };
}
