import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresGroupsStore } from "./groups.js";
import { PostgresSecurityPoliciesStore } from "./security-policies.js";
import { PostgresOAuthAppsStore } from "./oauth-apps.js";
import { PostgresBillingStore } from "./billing.js";
import { PostgresDomainsStore } from "./domains.js";

/**
 * Query-shape tests for the admin-console Postgres stores. These use the same
 * `createRecordingSql` mock the rest of the platform uses: they assert that
 * each store issues org-scoped, correctly-shaped SQL without needing a live
 * database. Behavioral coverage lives in the in-memory store tests.
 */

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

const orgId = "22222222-2222-4222-8222-222222222222";

function createRecordingSql(responses: readonly (readonly unknown[])[]): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  let callIndex = 0;
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve(responses[callIndex++] ?? []);
  };
  const helpers = {
    json: (value: unknown) => value,
    array: (value: unknown) => value,
  };
  return { sql: Object.assign(tag, helpers) as unknown as postgres.Sql, calls };
}

describe("PostgresGroupsStore", () => {
  it("lists org units scoped to the org with member and child counts", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresGroupsStore(recording.sql);
    await store.listOrgUnits(orgId);
    expect(recording.calls[0]?.text).toContain("from admin_org_units");
    expect(recording.calls[0]?.text).toContain("member_count");
    expect(recording.calls[0]?.text).toContain("child_count");
    expect(recording.calls[0]?.values).toContain(orgId);
  });

  it("lists groups with a membership count join", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresGroupsStore(recording.sql);
    await store.listGroups(orgId);
    expect(recording.calls[0]?.text).toContain("from admin_groups");
    expect(recording.calls[0]?.text).toContain("left join admin_group_members");
    expect(recording.calls[0]?.values).toContain(orgId);
  });
});

describe("PostgresSecurityPoliciesStore", () => {
  it("materializes default records for policy types with no row", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresSecurityPoliciesStore(recording.sql);
    const policies = await store.list(orgId);
    expect(recording.calls[0]?.text).toContain("from admin_security_policies");
    expect(policies).toHaveLength(6);
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
});

describe("PostgresDomainsStore", () => {
  it("lists domains org-scoped with the primary domain first", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresDomainsStore(recording.sql);
    await store.listDomains(orgId);
    expect(recording.calls[0]?.text).toContain("from admin_domains");
    expect(recording.calls[0]?.text).toContain("order by is_primary desc");
    expect(recording.calls[0]?.values).toContain(orgId);
  });

  it("clears sibling primary flags when promoting a domain", async () => {
    const recording = createRecordingSql([
      [
        {
          id: "55555555-5555-4555-8555-555555555555",
          org_id: orgId,
          domain: "helix.io",
          is_primary: false,
          verification_status: "verified",
          verified_at: null,
          created_at: new Date("2026-05-21T00:00:00.000Z"),
          updated_at: new Date("2026-05-21T00:00:00.000Z"),
        },
      ],
      [],
      [
        {
          id: "55555555-5555-4555-8555-555555555555",
          org_id: orgId,
          domain: "helix.io",
          is_primary: true,
          verification_status: "verified",
          verified_at: null,
          created_at: new Date("2026-05-21T00:00:00.000Z"),
          updated_at: new Date("2026-05-21T00:00:00.000Z"),
        },
      ],
    ]);
    const store = new PostgresDomainsStore(recording.sql);
    const domain = await store.setPrimaryDomain(orgId, "55555555-5555-4555-8555-555555555555");
    expect(recording.calls[1]?.text).toContain("set is_primary = false");
    expect(recording.calls[2]?.text).toContain("set is_primary = true");
    expect(domain?.isPrimary).toBe(true);
  });
});
