import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  defaultObjectStoreConfig,
  defaultObjectStorePrefix,
  objectStorePrefixStepName,
  PostgresTenantStorageNamespaceStore,
} from "./provisioning-storage.js";

const orgId = "11111111-1111-4111-8111-111111111111";

describe("PostgresTenantStorageNamespaceStore", () => {
  it("records the default object-store prefix and audit row without calling storage providers", async () => {
    const recording = createRecordingSql({ hadStorage: false });
    const store = new PostgresTenantStorageNamespaceStore(recording.sql);

    const record = await store.ensureDefaultObjectStorePrefix({ orgId });

    expect(record).toEqual({
      orgId,
      storage: defaultObjectStoreConfig(orgId),
    });
    expect(objectStorePrefixStepName).toBe("object_store_prefix");
    expect(defaultObjectStorePrefix(orgId)).toBe(`tenants/${orgId}/`);
    expect(recording.transactions).toBe(1);
    expect(recording.calls).toHaveLength(2);
    expect(recording.calls[0]?.text).toContain("byo_config ? 'storage' as had_storage");
    expect(recording.calls[0]?.text).toContain("for update");
    expect(recording.calls[0]?.text).toContain("coalesce(target.byo_config -> 'storage'");
    expect(recording.calls[1]?.text).toContain("insert into tenant_config_audit");
    expect(recording.calls[1]?.text).toContain(
      "tenant-provisioning:default-object-store-prefix",
    );
    expect(recording.calls[1]?.values).toEqual(
      expect.arrayContaining([
        orgId,
        defaultObjectStoreConfig(orgId),
      ]),
    );
    for (const call of recording.calls) {
      expect(call.text).not.toContain("ensureBucket");
      expect(call.text).not.toContain("vault");
    }
  });

  it("does not add audit rows when storage config already exists", async () => {
    const recording = createRecordingSql({
      hadStorage: true,
      storage: { kind: "byo", provider: "aws-s3", prefix: "helix/" },
    });
    const store = new PostgresTenantStorageNamespaceStore(recording.sql);

    const record = await store.ensureDefaultObjectStorePrefix({ orgId });

    expect(record.storage).toEqual({ kind: "byo", provider: "aws-s3", prefix: "helix/" });
    expect(recording.calls).toHaveLength(1);
  });
});

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function createRecordingSql(input: {
  readonly hadStorage: boolean;
  readonly storage?: Record<string, unknown>;
}): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
  readonly transactions: number;
} {
  const calls: RecordedQuery[] = [];
  let transactions = 0;
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve([
      {
        id: orgId,
        storage: input.storage ?? defaultObjectStoreConfig(orgId),
        had_storage: input.hadStorage,
      },
    ]);
  };
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
    begin: async (callback: (tx: postgres.TransactionSql) => Promise<unknown>) => {
      transactions += 1;
      return callback(sql as unknown as postgres.TransactionSql);
    },
  }) as unknown as postgres.Sql;
  return {
    sql,
    calls,
    get transactions() {
      return transactions;
    },
  };
}
