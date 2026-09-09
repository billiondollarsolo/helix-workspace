import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0125 Meet guest identity", () => {
  it("adds indexed codes, closed guest policy, scoped expiring invites, and forced RLS", async () => {
    const sql = await readFile(new URL("./0125_meet_guest_identity.sql", import.meta.url), "utf8");
    expect(sql).toContain("create unique index meet_rooms_org_join_code_idx");
    expect(sql).toContain("guest_policy in ('disabled', 'invite', 'domain')");
    expect(sql).toContain("token_hash text not null unique");
    expect(sql).toContain("foreign key (org_id, room_id)");
    expect(sql).toContain("force row level security");
    expect(sql).not.toContain("token text");
  });
});
