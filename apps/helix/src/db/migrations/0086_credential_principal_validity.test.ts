import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0086 credential principal validity", () => {
  it("defines one tenant-bound active principal evaluator", async () => {
    const migration = await readFile(
      new URL("./0086_credential_principal_validity.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("helix_credential_principal_is_active");
    expect(migration).toContain("a.id = principal_actor_id");
    expect(migration).toContain("a.org_id = tenant_org_id");
    expect(migration).toContain("a.disabled_at is null");
    expect(migration).toContain("o.status = 'active'");
  });
});
