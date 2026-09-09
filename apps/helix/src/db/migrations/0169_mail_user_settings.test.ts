import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("./0169_mail_user_settings.sql", import.meta.url), "utf8");

describe("mail user settings migration", () => {
  it("keeps signatures and block lists actor-scoped and bounded", () => {
    expect(migration).toContain("primary key (org_id, actor_id)");
    expect(migration).toContain("actor_id = helix_current_actor_id()");
    expect(migration).toContain("cardinality(blocked_senders) <= 1000");
  });
});
