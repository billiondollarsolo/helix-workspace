import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { StorageObject } from "@helix/sdk-types";
import { PostgresGovernanceStore } from "./ediscovery.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const matterId = "33333333-3333-4333-8333-333333333333";

function fakeSql() {
  const calls: string[] = [];
  const tag = (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    calls.push(text);
    if (text.includes("set_config('helix.org_id'")) return Promise.resolve([]);
    if (text.includes("helix_governance_search")) {
      return Promise.resolve([
        {
          item_key: "chat:message:item:current-2",
          product: "chat",
          resource_type: "message",
          resource_id: "44444444-4444-4444-8444-444444444444",
          revision: "current-2",
          occurred_at: new Date("2026-09-03T12:00:00Z"),
          custodians: [actorId],
          snapshot: { body: "held evidence", deleted_at: "2026-09-03T13:00:00Z" },
          storage_objects: [{ key: "drive/source", sha256: "a".repeat(64), byteSize: 4 }],
          item_sha256: "b".repeat(64),
          review_disposition: "responsive",
        },
      ]);
    }
    if (text.includes("helix_governance_record_export")) {
      return Promise.resolve([
        {
          id: "55555555-5555-4555-8555-555555555555",
          matter_id: matterId,
          object_key: `governance/exports/${matterId}/content`,
          content_sha256: "c".repeat(64),
          manifest: { version: 1, manifestSha256: "d".repeat(64) },
          manifest_sha256: "d".repeat(64),
          previous_manifest_sha256: null,
          created_at: new Date("2026-09-03T14:00:00Z"),
        },
      ]);
    }
    return Promise.resolve([]);
  };
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
    array: (value: unknown) => value,
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
      callback(sql as unknown as postgres.TransactionSql),
  }) as unknown as postgres.Sql;
  return { sql, calls };
}

describe("PostgresGovernanceStore", () => {
  it("returns deleted evidence with review state through the shared search", async () => {
    const database = fakeSql();
    const items = await new PostgresGovernanceStore(database.sql).search({
      orgId,
      actorId,
      matterId,
      query: "held",
    });
    expect(items).toEqual([
      expect.objectContaining({
        product: "chat",
        itemSha256: "b".repeat(64),
        reviewDisposition: "responsive",
        snapshot: expect.objectContaining({ deleted_at: expect.any(String) }),
      }),
    ]);
    expect(database.calls.some((call) => call.includes("helix_governance_search"))).toBe(true);
  });

  it("copies source bytes and writes content plus the chained custody manifest", async () => {
    const database = fakeSql();
    const puts: StorageObject[] = [];
    const copies: string[] = [];
    const store = new PostgresGovernanceStore(database.sql, () => ({
      managedBy: "helix-default",
      prefix: "",
      client: {
        put: async (object) => {
          puts.push(object);
        },
        get: async () => null,
        delete: async () => undefined,
        head: async (key) => ({ key, byteSize: 4 }),
        copy: async (source, destination) => {
          copies.push(`${source}:${destination}`);
        },
      },
    }));

    const exported = await store.exportMatter({ orgId, actorId, matterId, query: "held" });

    expect(exported.manifest_sha256).toBe("d".repeat(64));
    expect(copies).toEqual([expect.stringMatching(/^drive\/source:governance\/exports\//u)]);
    expect(puts).toHaveLength(2);
    expect(puts.map((object) => object.contentType)).toEqual([
      "application/json",
      "application/json",
    ]);
    expect(database.calls.some((call) => call.includes("helix_governance_record_export"))).toBe(
      true,
    );
  });
});
