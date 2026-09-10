import { describe, expect, it } from "vitest";
import { createRecordingSql } from "../../test-support/recording-sql.js";
import { PostgresBillingStore } from "./billing.js";
import { PostgresDomainsStore } from "./domains.js";
import { PostgresGroupsStore } from "./groups.js";
import { PostgresOAuthAppsStore } from "./oauth-apps.js";
import { PostgresSecurityPoliciesStore } from "./security-policies.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";

describe("PostgresGroupsStore", () => {
  it("lists org units scoped to the org with member and child counts", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresGroupsStore(recording.sql);
    await store.listOrgUnits(orgId);
    expect(recording.calls[0]?.text).toContain("from admin_org_units");
    expect(recording.calls[0]?.text).toContain("member_count");
    expect(recording.calls[0]?.text).toContain("child_count");
    expect(recording.calls[0]?.text).toContain("gm.org_id = g.org_id");
    expect(recording.calls[0]?.text).toContain("a.disabled_at is null");
    expect(recording.calls[0]?.values).toContain(orgId);
  });

  it("lists groups with a membership count join", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresGroupsStore(recording.sql);
    await store.listGroups(orgId);
    expect(recording.calls[0]?.text).toContain("from admin_groups");
    expect(recording.calls[0]?.text).toContain("left join admin_group_members");
    expect(recording.calls[0]?.text).toContain("gm.org_id = g.org_id");
    expect(recording.calls[0]?.text).toContain("a.disabled_at is null");
    expect(recording.calls[0]?.values).toContain(orgId);
  });

  it("lists only active same-tenant members of the requested group", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresGroupsStore(recording.sql);
    await store.listGroupMembers(orgId, "33333333-3333-4333-8333-333333333333");
    expect(recording.calls[0]?.text).toContain("g.org_id = gm.org_id");
    expect(recording.calls[0]?.text).toContain("a.org_id = gm.org_id");
    expect(recording.calls[0]?.text).toContain("a.disabled_at is null");
    expect(recording.calls[0]?.values).toContain(orgId);
  });
});

describe("PostgresSecurityPoliciesStore", () => {
  it("materializes default records for policy types with no row", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresSecurityPoliciesStore(recording.sql);
    const policies = await store.list(orgId);
    expect(recording.calls[0]?.text).toContain("from admin_security_policies");
    expect(policies).toHaveLength(7);
    expect(policies.every((policy) => policy.orgId === orgId)).toBe(true);
  });

  it("upserts a policy with on-conflict semantics", async () => {
    const recording = createRecordingSql([
      [
        {
          id: "33333333-3333-4333-8333-333333333333",
          org_id: orgId,
          policy_type: "mfa",
          enabled: true,
          enforcement: "required",
          settings: { allowedMethods: ["totp"] },
          updated_by: null,
          created_at: new Date("2026-05-21T00:00:00.000Z"),
          updated_at: new Date("2026-05-21T00:00:00.000Z"),
        },
      ],
    ]);
    const store = new PostgresSecurityPoliciesStore(recording.sql);
    const policy = await store.upsert({
      orgId,
      policyType: "mfa",
      enabled: true,
      enforcement: "required",
      settings: { allowedMethods: ["totp"] },
      updatedBy: "11111111-1111-4111-8111-111111111111",
    });
    expect(recording.calls[0]?.text).toContain("insert into admin_security_policies");
    expect(recording.calls[0]?.text).toContain("on conflict (org_id, policy_type) do update");
    expect(policy.enabled).toBe(true);
  });
});

describe("PostgresOAuthAppsStore", () => {
  it("lists apps with org scope, status/risk filters, and keyset pagination", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresOAuthAppsStore(recording.sql);
    await store.list({ orgId, limit: 51, status: "approved", risk: "high", query: "git" });
    const call = recording.calls[0];
    expect(call?.text).toContain("from admin_oauth_apps");
    expect(call?.text).toContain("(created_at, id) <");
    expect(call?.values).toContain(orgId);
    expect(call?.values).toContain("approved");
    expect(call?.values).toContain("high");
    expect(call?.values).toContain(51);
  });

  it("revokes by writing the terminal status", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresOAuthAppsStore(recording.sql);
    await store.setStatus({
      orgId,
      id: "44444444-4444-4444-8444-444444444444",
      status: "revoked",
      reviewedBy: "11111111-1111-4111-8111-111111111111",
    });
    expect(recording.calls[0]?.text).toContain("update admin_oauth_apps");
    expect(recording.calls[0]?.values).toContain("revoked");
  });
});

describe("PostgresBillingStore", () => {
  it("reads the billing account scoped to the org", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresBillingStore(recording.sql);
    await store.getAccount(orgId);
    expect(recording.calls[0]?.text).toContain("from admin_billing_accounts");
    expect(recording.calls[0]?.values).toContain(orgId);
  });

  it("lists invoices ordered by issued date with a keyset cursor", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresBillingStore(recording.sql);
    await store.listInvoices({
      orgId,
      limit: 51,
      cursor: { createdAt: new Date("2026-05-01T00:00:00.000Z"), id: "x" },
    });
    expect(recording.calls[0]?.text).toContain("from admin_billing_invoices");
    expect(recording.calls[0]?.text).toContain("(issued_at, id) <");
    expect(recording.calls[0]?.values).toContain(51);
  });

  it("lists usage rollups scoped to org, period, and metric key", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresBillingStore(recording.sql);
    const from = new Date("2026-05-01T00:00:00.000Z");
    const to = new Date("2026-05-31T00:00:00.000Z");
    await store.listUsageRollups({
      orgId,
      from,
      to,
      metricKey: "ai_tokens",
    });

    expect(recording.calls[0]?.text).toContain("from metering_rollups");
    expect(recording.calls[0]?.text).toContain("org_id = ?");
    expect(recording.calls[0]?.text).toContain("period_start >=");
    expect(recording.calls[0]?.text).toContain("metric_key =");
    expect(recording.calls[0]?.values).toEqual(
      expect.arrayContaining([orgId, from, to, "ai_tokens"]),
    );
  });

  it("rejects usage rollup rows with unknown metric keys", async () => {
    const recording = createRecordingSql([
      [
        {
          org_id: orgId,
          period_start: new Date("2026-05-23T00:00:00.000Z"),
          period_end: new Date("2026-05-24T00:00:00.000Z"),
          metric_key: "custom_metric",
          quantity: "1",
          computed_at: new Date("2026-05-24T00:05:00.000Z"),
        },
      ],
    ]);
    const store = new PostgresBillingStore(recording.sql);

    await expect(store.listUsageRollups({ orgId })).rejects.toThrow(
      "Unknown metering rollup metric key",
    );
  });
});

describe("PostgresDomainsStore", () => {
  it("resolves tenant routing only through a verified exact domain", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresDomainsStore(recording.sql);
    await expect(store.findVerifiedDomain("workspace.example.org")).resolves.toBeNull();
    expect(recording.calls[0]?.text).toContain("helix_verified_tenant_domain");
    expect(recording.calls[0]?.values).toContain("workspace.example.org");
  });

  it("lists domains org-scoped with the primary domain first", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresDomainsStore(recording.sql);
    await store.listDomains(orgId);
    expect(recording.calls[0]?.text).toContain("from admin_domains");
    expect(recording.calls[0]?.text).toContain("order by is_primary desc");
    expect(recording.calls[0]?.values).toContain(orgId);
  });

  it("promotes through the serialized audited transition function", async () => {
    const recording = createRecordingSql([
      [
        {
          id: "55555555-5555-4555-8555-555555555555",
          org_id: orgId,
          domain: "helix.io",
          is_primary: true,
          status: "verified",
          verified_at: new Date("2026-05-21T00:00:00.000Z"),
          identity_enabled: true,
          mail_enabled: true,
          aliases_enabled: true,
          custom_host_enabled: true,
          federation_enabled: false,
          provider_id: null,
          identity_mode: "secondary",
          alias_target_domain_id: null,
          verification_host: "_helix-verification.helix.io",
          verification_value: "helix-domain-verification=test",
          verification_expires_at: new Date("2026-05-24T00:00:00.000Z"),
          verification_attempts: 1,
          verification_last_attempt_at: new Date("2026-05-21T00:00:00.000Z"),
          quarantined_at: null,
          released_at: null,
          claimable_after: null,
          created_at: new Date("2026-05-21T00:00:00.000Z"),
          updated_at: new Date("2026-05-21T00:00:00.000Z"),
        },
      ],
    ]);
    const store = new PostgresDomainsStore(recording.sql);
    const domain = await store.setPrimaryDomain(
      orgId,
      "55555555-5555-4555-8555-555555555555",
      actorId,
    );
    expect(recording.calls[0]?.text).toContain("helix_set_primary_domain");
    expect(recording.calls[0]?.values).toEqual(
      expect.arrayContaining([orgId, "55555555-5555-4555-8555-555555555555", actorId]),
    );
    expect(domain?.isPrimary).toBe(true);
  });
});
