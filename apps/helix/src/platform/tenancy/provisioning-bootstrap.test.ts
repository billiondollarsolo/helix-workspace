import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  PostgresTenantBootstrapSeedStore,
  tenantBootstrapSeedStepName,
} from "./provisioning-bootstrap.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const ownerActorId = "22222222-2222-4222-8222-222222222222";

describe("PostgresTenantBootstrapSeedStore", () => {
  it("seeds the owner org permission and bootstrap activity idempotence marker", async () => {
    const recording = createRecordingSql({});
    const store = new PostgresTenantBootstrapSeedStore(recording.sql);

    const record = await store.ensureTenantBootstrapSeed({
      orgId,
      ownerEmail: "Owner@Example.COM",
    });

    expect(record).toEqual({
      orgId,
      ownerActorId,
      permissionSeeded: true,
      activitySeeded: true,
    });
    expect(tenantBootstrapSeedStepName).toBe("tenant_bootstrap_seeded");
    expect(recording.transactions).toBe(1);
    expect(recording.calls).toHaveLength(5);
    expect(recording.calls[0]?.text).toContain("from actors");
    expect(recording.calls[0]?.text).toContain("lower(email)");
    expect(recording.calls[0]?.values).toEqual(
      expect.arrayContaining([orgId, "owner@example.com"]),
    );
    expect(recording.calls[1]?.text).toContain("insert into permissions");
    expect(recording.calls[1]?.text).toContain("resource_type = 'org'");
    expect(recording.calls[1]?.text).toContain("where not exists");
    expect(recording.calls[2]?.text).toContain("verb = 'tenant.bootstrap.seeded'");
    expect(recording.calls[3]?.text).toContain("select this_hash from activity");
    expect(recording.calls[4]?.text).toContain("insert into activity");
    expect(recording.calls[4]?.values).toEqual(
      expect.arrayContaining([
        orgId,
        ownerActorId,
        {
          source: "tenant-provisioning",
          defaultPermissions: ["org.owner"],
        },
      ]),
    );
  });

  it("does not duplicate permission or activity rows when already seeded", async () => {
    const recording = createRecordingSql({ permissionExists: true, activityExists: true });
    const store = new PostgresTenantBootstrapSeedStore(recording.sql);

    const record = await store.ensureTenantBootstrapSeed({
      orgId,
      ownerEmail: "owner@example.com",
    });

    expect(record).toEqual({
      orgId,
      ownerActorId,
      permissionSeeded: false,
      activitySeeded: false,
    });
    expect(recording.calls).toHaveLength(3);
    expect(recording.calls.some((call) => call.text.includes("insert into activity"))).toBe(false);
  });

  it("fails clearly when the owner actor has not been created yet", async () => {
    const recording = createRecordingSql({ ownerExists: false });
    const store = new PostgresTenantBootstrapSeedStore(recording.sql);

    await expect(
      store.ensureTenantBootstrapSeed({
        orgId,
        ownerEmail: "owner@example.com",
      }),
    ).rejects.toThrow("tenant bootstrap seed requires an existing owner actor");
  });
});

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function createRecordingSql(input: {
  readonly ownerExists?: boolean;
  readonly permissionExists?: boolean;
  readonly activityExists?: boolean;
  readonly previousHash?: string | null;
}): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
  readonly transactions: number;
} {
  const calls: RecordedQuery[] = [];
  let transactions = 0;
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    if (text.includes("from actors")) {
      return Promise.resolve(input.ownerExists === false ? [] : [{ id: ownerActorId }]);
    }
    if (text.includes("insert into permissions")) {
      return Promise.resolve(input.permissionExists === true ? [] : [{ id: "permission-1" }]);
    }
    if (text.includes("verb = 'tenant.bootstrap.seeded'")) {
      return Promise.resolve(input.activityExists === true ? [{ id: "activity-1" }] : []);
    }
    if (text.includes("select this_hash from activity")) {
      return Promise.resolve(
        input.previousHash === undefined || input.previousHash === null
          ? []
          : [{ this_hash: input.previousHash }],
      );
    }
    return Promise.resolve([]);
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
