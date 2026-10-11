import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { TenantEnvelopeCipher } from "../secrets/envelope.js";
import { PostgresWebhookStore } from "../webhooks/index.js";

const databaseUrl = process.env.HELIX_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
const unlimitedOrgId = "d5720000-0000-4000-8000-000000000001";
const nullLimitOrgId = "d5720000-0000-4000-8000-000000000002";
const cappedOrgId = "d5720000-0000-4000-8000-000000000003";
const fixtureOrgIds = [unlimitedOrgId, nullLimitOrgId, cappedOrgId];

describe(
  "free and unlimited tenants (PostgreSQL)",
  { skip: skipUnlessLiveDatabase("free and unlimited tenants") },
  () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
      if (databaseUrl === undefined) throw new Error("Database URL is required.");
      sql = postgres(databaseUrl, { max: 2, prepare: false });
      await cleanupTestTenants(sql, fixtureOrgIds);
      await sql`
        insert into orgs (id, slug, display_name, status, quotas)
        values
          (${unlimitedOrgId}, 'unlimited-quotas-default', 'Unlimited default', 'active', '{}'),
          (${nullLimitOrgId}, 'unlimited-quotas-null', 'Unlimited null', 'active',
            ${sql.json({ storage_bytes_limit: null, outbound_webhooks_limit: null })}),
          (${cappedOrgId}, 'unlimited-quotas-capped', 'Admin capped', 'active',
            ${sql.json({ storage_bytes_limit: 1_000 })})
      `;
    });

    afterAll(async () => {
      await cleanupTestTenants(sql, fixtureOrgIds);
      await sql.end();
    });

    it("has no plans table or org plan column", async () => {
      const [row] = await sql<{ plans: string | null; plan_columns: number }[]>`
        select
          to_regclass('public.plans')::text as plans,
          (
            select count(*)::int from information_schema.columns
            where table_schema = 'public' and table_name = 'orgs' and column_name = 'plan_id'
          ) as plan_columns
      `;
      expect(row).toEqual({ plans: null, plan_columns: 0 });
    });

    it("treats a missing or null storage limit as unlimited", async () => {
      const rows = await sql<{ org_id: string; limit_bytes: string | null }[]>`
        select org_id::text, public.helix_storage_limit_bytes(org_id)::text as limit_bytes
        from unnest(${sql.array(fixtureOrgIds)}::uuid[]) as org_id
        order by org_id
      `;
      expect(rows).toEqual([
        { org_id: unlimitedOrgId, limit_bytes: null },
        { org_id: nullLimitOrgId, limit_bytes: null },
        // An org admin can still opt into a cap for its own tenant.
        { org_id: cappedOrgId, limit_bytes: "1000" },
      ]);
    });

    it("creates more than five outbound webhooks without a configured limit", async () => {
      const store = new PostgresWebhookStore(
        sql,
        new TenantEnvelopeCipher("unlimited-quotas-master-key-at-least-32-bytes"),
      );
      for (const orgId of [unlimitedOrgId, nullLimitOrgId]) {
        for (let index = 0; index < 7; index += 1) {
          await store.createOutbound({
            orgId,
            name: `Endpoint ${String(index)}`,
            url: `https://example.com/webhooks/${String(index)}`,
            eventSubjects: ["deploy.created"],
            secret: "unlimited-quotas-webhook-secret-32-bytes",
          });
        }
      }
      const counts = await sql<{ org_id: string; count: number }[]>`
        select org_id::text, count(*)::int as count
        from outbound_webhooks
        where org_id in ${sql([unlimitedOrgId, nullLimitOrgId])} and deleted_at is null
        group by org_id
        order by org_id
      `;
      expect(counts).toEqual([
        { org_id: unlimitedOrgId, count: 7 },
        { org_id: nullLimitOrgId, count: 7 },
      ]);
    });
  },
);
