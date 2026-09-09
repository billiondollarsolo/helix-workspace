import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0087 SCIM credential governance migration", () => {
  it("enforces multi-key lifecycle, tenant ownership, scoped policy, and RLS", async () => {
    const sql = await readFile(
      new URL("./0087_scim_credential_governance.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("add constraint tenant_scim_credentials_pkey primary key (id)");
    expect(sql).toContain("tenant_scim_credentials_scopes_valid");
    expect(sql).toContain("source_cidrs inet[]");
    expect(sql).toContain("expires_at timestamptz not null");
    expect(sql).toContain("revoked_at timestamptz");
    expect(sql).toContain("last_used_at timestamptz");
    expect(sql).toContain("tenant_scim_credentials_created_by_org_fk");
    expect(sql).toContain("alter table tenant_scim_credentials enable row level security");
    expect(sql).toContain("with check (org_id = helix_current_org_id())");
    expect(sql).toContain("SCIM Security Principal");
  });
});
