import { describe, expect, it } from "vitest";
import { createRecordingSql as sharedRecordingSql } from "../../test-support/recording-sql.js";
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
    expect(recording.calls[1]?.text).toContain("tenant-provisioning:default-object-store-prefix");
    expect(recording.calls[1]?.values).toEqual(
      expect.arrayContaining([orgId, defaultObjectStoreConfig(orgId)]),
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
function createRecordingSql(input: {
  readonly hadStorage: boolean;
  readonly storage?: Record<string, unknown>;
}) {
  const recording = sharedRecordingSql(() => {
    return Promise.resolve([
      {
        id: orgId,
        storage: input.storage ?? defaultObjectStoreConfig(orgId),
        had_storage: input.hadStorage,
      },
    ]);
  }, "?");
  return {
    ...recording,
    get transactions() {
      return recording.beginCalls;
    },
    get beginCalls() {
      return recording.beginCalls;
    },
  };
}
