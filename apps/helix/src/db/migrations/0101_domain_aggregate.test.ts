import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("canonical workspace domains", () => {
  it("collapses ownership and mail into one globally exclusive aggregate", async () => {
    const sql = await readFile(new URL("./0101_domain_aggregate.sql", import.meta.url), "utf8");

    expect(sql).toContain("create unique index admin_domains_active_domain_idx");
    expect(sql).toContain("where status <> 'released'");
    expect(sql).toContain("drop table mail_sending_domains");
    expect(sql).toContain("mail_dkim_keys_domain_org_fk");
    expect(sql).toContain("admin_dns_records_domain_org_fk");
    expect(sql).toContain("admin_domains_provider_org_fk");
    expect(sql).toContain("admin_domains_alias_target_org_fk");
    expect(sql).not.toContain("create view mail_sending_domains");
  });

  it("serializes verified-only primary changes with rollback and cooldown", async () => {
    const sql = await readFile(new URL("./0102_domain_transitions.sql", import.meta.url), "utf8");

    expect(sql).toContain("admin_domains_exactly_one_primary");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("target.status <> 'verified'");
    expect(sql).toContain("domain_primary_dependency");
    expect(sql).toContain("interval '1 hour'");
    expect(sql).toContain("helix_rollback_primary_domain");
    expect(sql).toContain("admin_domain_primary_transitions");
    expect(sql).not.toContain("bypass_cooldown");
  });

  it("defines independent secondary namespaces and local-part-preserving aliases", async () => {
    const sql = await readFile(
      new URL("./0103_domain_identity_semantics.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("helix_canonical_login_email");
    expect(sql).toContain("helix_discover_domain_identity");
    expect(sql).toContain("helix_assert_directory_address");
    expect(sql).toContain("organization_memberships_address_guard");
    expect(sql).toContain("membership.status = 'active'");
    expect(sql).toContain("domain.mail_enabled");
  });
});
