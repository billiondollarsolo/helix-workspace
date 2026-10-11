import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";

const databaseUrl = process.env.HELIX_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
const org = "d2050000-0000-4000-8000-00000000000a";
const untouchedOrg = "d2050000-0000-4000-8000-00000000000b";

class Rollback extends Error {}

describe(
  "0205 drop unused tenant flags and metering metrics migration (PostgreSQL)",
  { skip: skipUnlessLiveDatabase("unused tenant flag and metering metric removal") },
  () => {
    let sql: postgres.Sql;
    let migration = "";

    beforeAll(async () => {
      if (databaseUrl === undefined) throw new Error("Database URL is required.");
      sql = postgres(databaseUrl, { max: 1, prepare: false });
      migration = await readFile(
        new URL("./0205_drop_unused_tenant_flags_and_metering_metrics.sql", import.meta.url),
        "utf8",
      );
      await cleanupTestTenants(sql, [org, untouchedOrg]);
    });

    afterAll(async () => {
      await cleanupTestTenants(sql, [org, untouchedOrg]);
      await sql.end();
    });

    it("strips unused flag keys, keeps live ones and drops unused metering rows", async () => {
      const outcome = await sql
        .begin(async (tx) => {
          await tx`
            insert into orgs (id, slug, display_name, feature_flags, branding)
            values
              (${org}, 'drop-unused-flags', 'Drop unused flags',
                ${tx.json({
                  assistant_retrieval: false,
                  mail_outbound: false,
                  calendar_import_invitations: true,
                  mail_inbound_policy: { mode: "quarantine" },
                  ai_smart_compose: true,
                  dlp_enforcement: "block",
                  watermark: "both",
                  b2b_sharing: true,
                  byo_storage: true,
                  byo_kms: true,
                  sso_saml: true,
                  scim_provisioning: true,
                  custom_domain: true,
                  white_label: true,
                  multi_region_dr: true,
                  dedicated_csm: true,
                  marketplace_install_paid: true,
                  support_tier: "premium",
                })},
                ${tx.json({ custom_domain: "mail.example.com" })}),
              (${untouchedOrg}, 'keep-flags', 'Keep flags',
                ${tx.json({ mail_outbound: false })}, '{}')
          `;
          await tx`
            insert into metering_events (org_id, event_type, quantity)
            values
              (${org}, 'ai.tokens', 10),
              (${org}, 'storage.delta', 20),
              (${org}, 'export.completed', 1),
              (${org}, 'seats.delta', 1),
              (${org}, 'api.call.billable', 1),
              (${org}, 'collab.session.opened', 1)
          `;
          await tx`
            insert into metering_rollups (org_id, period_start, period_end, metric_key, quantity)
            select ${org}, date '2026-10-01', date '2026-10-02', metric, 1
            from unnest(array[
              'ai_tokens', 'storage_avg_bytes', 'exports_count', 'seats_delta', 'seats_max',
              'api_calls_billable', 'collab_session_seconds'
            ]) metric
          `;
          const [auditBefore] = await tx<{ count: number }[]>`
            select count(*)::int as count from tenant_config_audit
            where org_id in (${org}, ${untouchedOrg}) and key = 'feature_flags'
          `;

          await tx.unsafe(migration);

          const orgs = await tx<{ id: string; feature_flags: unknown; branding: unknown }[]>`
            select id::text, feature_flags, branding from orgs
            where id in (${org}, ${untouchedOrg}) order by id
          `;
          const events = await tx<{ event_type: string }[]>`
            select event_type from metering_events where org_id = ${org} order by event_type
          `;
          const rollups = await tx<{ metric_key: string }[]>`
            select metric_key from metering_rollups where org_id = ${org} order by metric_key
          `;
          const audit = await tx<{ org_id: string; reason: string }[]>`
            select org_id::text, reason from tenant_config_audit
            where org_id in (${org}, ${untouchedOrg}) and key = 'feature_flags'
            order by changed_at offset ${auditBefore?.count ?? 0}
          `;
          throw new Rollback(JSON.stringify({ orgs, events, rollups, audit }));
        })
        .catch((error: unknown) => {
          if (error instanceof Rollback) return JSON.parse(error.message) as unknown;
          throw error;
        });

      expect(outcome).toEqual({
        orgs: [
          {
            id: org,
            feature_flags: {
              assistant_retrieval: false,
              mail_outbound: false,
              calendar_import_invitations: true,
              mail_inbound_policy: { mode: "quarantine" },
            },
            branding: { custom_domain: "mail.example.com" },
          },
          { id: untouchedOrg, feature_flags: { mail_outbound: false }, branding: {} },
        ],
        events: [
          { event_type: "ai.tokens" },
          { event_type: "export.completed" },
          { event_type: "storage.delta" },
        ],
        rollups: [
          { metric_key: "ai_tokens" },
          { metric_key: "exports_count" },
          { metric_key: "storage_avg_bytes" },
        ],
        audit: [{ org_id: org, reason: "migration: drop unused tenant feature flags" }],
      });
    });
  },
);
