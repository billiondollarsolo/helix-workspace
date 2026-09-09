import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0163 non-human credential lifecycle migration", () => {
  it("governs every retained credential type in one tenant-bound lifecycle", async () => {
    const migration = await readFile(
      new URL("./0163_nonhuman_credential_lifecycle.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("helix_issue_nonhuman_credential");
    expect(migration).toContain("helix_rotate_nonhuman_credential");
    expect(migration).toContain("helix_revoke_nonhuman_credential");
    expect(migration).toContain("credential principal must be an active agent or service account");
    expect(migration).toContain("owner_actor_id");
    expect(migration).toContain("purpose");
    expect(migration).toContain("expires_at set not null");
  });

  it("commits tamper-evident audit and delivery evidence with each mutation", async () => {
    const migration = await readFile(
      new URL("./0163_nonhuman_credential_lifecycle.sql", import.meta.url),
      "utf8",
    );
    expect(migration.match(/insert into activity/gu)).toHaveLength(3);
    expect(migration.match(/insert into outbox/gu)).toHaveLength(3);
    expect(migration).toContain("security.nonhuman-credential.changed");
    expect(migration).not.toContain("clientSecret");
  });
});
