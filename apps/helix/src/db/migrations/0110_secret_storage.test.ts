import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("./0110_secret_storage.sql", import.meta.url), "utf8");

describe("0110 secret storage migration", () => {
  it("invalidates plaintext identity credentials and removes legacy secret columns", () => {
    for (const column of ['"accessToken"', '"refreshToken"', '"idToken"']) {
      expect(migration).toContain(`set ${column} = null`);
    }
    expect(migration).toContain("better_auth_two_factor_secret_encrypted");
    expect(migration).toContain("drop column if exists private_key_pem");
    expect(migration).toContain("drop column if exists secret_ref");
    expect(migration).toContain("private_key_ciphertext ~ '^helix[$]1");
    expect(migration).toContain("secret_ciphertext ~ '^helix[$]1");
  });

  it("projects provider JSON to public fields and rejects storage credentials", () => {
    expect(migration).toContain("mail_outbound_providers_public_config");
    expect(migration).toContain("tenant_idp_configs_public_config");
    expect(migration).toContain("tenant_idp_configs_public_attr_mapping");
    expect(migration).toContain("orgs_byo_config_no_credentials");
    expect(migration).toContain("tenant_storage_migration_jobs_source_no_credentials");
    expect(migration).toContain("tenant_config_audit_values_no_credentials");
    expect(migration).toContain("secret[-_]?access[-_]?key");
    expect(migration).toContain("refresh[-_]?token");
  });
});
