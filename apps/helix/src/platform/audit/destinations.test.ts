import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { auditDestinationKinds, createAuditDestinationShipper } from "./destinations.js";
import { SiemAuditShipper } from "./siem-syslog.js";
import { PostgresWormAuditShipper } from "./immutable-postgres.js";
import {
  createHmacAuditAnchorAuthenticator,
  type ImmutableAuditStorageClient,
} from "./immutable-s3.js";
import type { AuditVerificationStore } from "./verifier.js";

function fakeStorage(): ImmutableAuditStorageClient & {
  listKeys(prefix: string): AsyncIterable<string>;
} {
  return {
    put: async () => undefined,
    get: async () => null,
    delete: async () => undefined,
    putObjectLocked: async () => undefined,
    async *listKeys() {},
  };
}

const authenticator = createHmacAuditAnchorAuthenticator("audit-key-1", "a".repeat(32));
const audit: AuditVerificationStore = { listVerificationRecords: async () => [] };

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
    const shipper = createAuditDestinationShipper(
      {
        destination: "immutable-s3",
        storage: fakeStorage(),
        prefix: "helix-audit",
        signer: authenticator,
        verifier: authenticator,
      },
      { audit },
    );
    expect(typeof shipper.ship).toBe("function");
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
