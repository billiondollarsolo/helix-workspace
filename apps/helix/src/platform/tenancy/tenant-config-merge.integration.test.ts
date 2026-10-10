import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { PostgresOrgStore } from "./orgs.js";

const databaseUrl = process.env.HELIX_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
const orgId = "d5710000-0000-4000-8000-000000000001";

describe(
  "tenant config feature flag merge (PostgreSQL)",
  { skip: skipUnlessLiveDatabase("tenant config feature flag merge") },
  () => {
    let sql: postgres.Sql;
    let store: PostgresOrgStore;

    beforeAll(async () => {
      if (databaseUrl === undefined) throw new Error("Database URL is required.");
      sql = postgres(databaseUrl, { max: 2, prepare: false });
      await cleanupTestTenants(sql, [orgId]);
      await sql`
        insert into orgs (id, slug, display_name, status, byo_config, feature_flags, quotas)
        values (
          ${orgId}, 'tenant-config-merge', 'Tenant config merge', 'active',
          ${sql.json({ storage: { kind: "byo", credentials_secret_handle: "tenant-config-merge" } })},
          ${sql.json({ byo_storage: true, dlp_enforcement: "warn", ai_smart_compose: true })},
          ${sql.json({ api_rps_limit: 5 })}
        )
      `;
      store = new PostgresOrgStore(sql);
    });

    afterAll(async () => {
      await cleanupTestTenants(sql, [orgId]);
      await sql.end();
    });

    it("keeps unsubmitted flags, so BYO storage orgs stay listed", async () => {
      const updated = await store.updateTenantConfig({
        orgId,
        featureFlags: { ai_smart_compose: false },
        quotas: { actors_limit: null },
      });

      expect(updated?.featureFlags).toEqual({
        byo_storage: true,
        dlp_enforcement: "warn",
        ai_smart_compose: false,
      });
      expect(updated?.quotas).toEqual({ api_rps_limit: 5, actors_limit: null });
      await expect(store.listByoStorageOrgIds({ limit: 1_000 })).resolves.toContain(orgId);

      const cleared = await store.updateTenantConfig({
        orgId,
        featureFlags: { dlp_enforcement: null },
      });
      expect(cleared?.featureFlags).toEqual({ byo_storage: true, ai_smart_compose: false });
    });
  },
);
