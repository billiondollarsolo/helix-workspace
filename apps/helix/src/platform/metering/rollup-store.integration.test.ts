import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { uniqueTestRole } from "../../test-support/test-role.js";
import { tenantAwarePostgresSql } from "../tenancy/postgres-roles.js";
import { PostgresMeteringRollupStore } from "./store.js";

const ORG = "fe7e0000-0000-4000-8000-000000000011";
const OTHER_ORG = "fe7e0000-0000-4000-8000-000000000012";
const skip = skipUnlessLiveDatabase("Metering rollup under the runtime role");

describe("Metering rollup under the runtime role", { skip }, () => {
  const { name: role, password } = uniqueTestRole("helix_metering_rollup");
  let admin: postgres.Sql;
  let runtimeRaw: postgres.Sql;
  let runtime: postgres.Sql;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL ?? "";
    admin = postgres(databaseUrl, { max: 2, prepare: false });
    await cleanupTestTenants(admin, [ORG, OTHER_ORG]);
    await admin.unsafe(
      `create role ${role} login inherit nosuperuser nobypassrls password '${password}'`,
    );
    await admin.unsafe(`grant helix_app to ${role}`);
    await admin`
      insert into orgs (id, slug, display_name) values
        (${ORG}, 'metering-rollup', 'Metering rollup'),
        (${OTHER_ORG}, 'metering-rollup-other', 'Metering rollup other')
    `;
    await admin`
      insert into metering_events (org_id, event_type, quantity, metadata, occurred_at) values
        (${ORG}, 'ai.tokens', 10, '{}', '2026-05-20T08:00:00Z'),
        (${ORG}, 'ai.tokens', 5, '{}', '2026-05-20T09:00:00Z'),
        (${ORG}, 'storage.delta', 100, '{}', '2026-05-20T10:00:00Z'),
        (${OTHER_ORG}, 'export.completed', 1, '{}', '2026-05-21T10:00:00Z'),
        (${OTHER_ORG}, 'ai.tokens', 99, '{}', '2026-05-26T10:00:00Z')
    `;
    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    runtimeRaw = postgres(runtimeUrl.href, { max: 4, prepare: false });
    runtime = tenantAwarePostgresSql(runtimeRaw);
  });

  afterAll(async () => {
    await runtimeRaw.end();
    await cleanupTestTenants(admin, [ORG, OTHER_ORG]);
    await admin.unsafe(`drop role if exists ${role}`);
    await admin.end();
  });

  it("produces each tenant's rollups and leaves the current day unrolled", async () => {
    const store = new PostgresMeteringRollupStore(runtime);

    const result = await store.rollupCompletedPeriods({
      cutoff: new Date("2026-05-24T00:00:00.000Z"),
      periodLimit: 50,
    });

    expect(result.periodCount).toBeGreaterThanOrEqual(2);
    expect(result.eventCount).toBeGreaterThanOrEqual(4);
    const rollups = await admin<{ org_id: string; metric_key: string; quantity: string }[]>`
      select org_id, metric_key, quantity::text as quantity from metering_rollups
      where org_id in (${ORG}, ${OTHER_ORG})
      order by org_id, metric_key
    `;
    expect(rollups).toEqual([
      { org_id: ORG, metric_key: "ai_tokens", quantity: "15" },
      { org_id: ORG, metric_key: "storage_avg_bytes", quantity: expect.any(String) },
      { org_id: ORG, metric_key: "storage_delta_bytes", quantity: "100" },
      { org_id: OTHER_ORG, metric_key: "exports_count", quantity: "1" },
      { org_id: OTHER_ORG, metric_key: "storage_avg_bytes", quantity: expect.any(String) },
    ]);
    const pending = await admin<{ count: string }[]>`
      select count(*) from metering_events
      where org_id in (${ORG}, ${OTHER_ORG}) and rolled_up_at is null
    `;
    expect(pending[0]?.count).toBe("1");
  });
});
