import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0159 OIDC SSO runtime migration", () => {
  it("projects only verified tenant OIDC state without storing credentials", async () => {
    const sql = await readFile(new URL("./0159_oidc_sso_runtime.sql", import.meta.url), "utf8");
    expect(sql).toContain('create table if not exists "ssoProvider"');
    expect(sql).toContain("'tokenEndpointAuthentication', 'private_key_jwt'");
    expect(sql).toContain("'pkce', true");
    expect(sql).toContain("domain.federation_enabled");
    expect(sql).toContain('domain, "domainVerified", "createdAt"');
    expect(sql).toContain("config.protocol = 'oidc'");
    expect(sql).not.toContain("clientSecret");
  });

  it("keeps runtime projection synchronized with IdP and domain state", async () => {
    const sql = await readFile(new URL("./0159_oidc_sso_runtime.sql", import.meta.url), "utf8");
    expect(sql).toContain("tenant_idp_configs_sync_oidc_sso");
    expect(sql).toContain("admin_domains_sync_oidc_sso");
    expect(sql).toContain('delete from "ssoProvider"');
    expect(sql).toContain("where protocol = 'saml'");
  });
});
