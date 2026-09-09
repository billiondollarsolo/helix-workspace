import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0134 mail draft contract migration", () => {
  it("adds optimistic revisions, replay safety, attachment retention, and bounded cleanup", async () => {
    const sql = await readFile(new URL("./0134_mail_draft_contract.sql", import.meta.url), "utf8");
    expect(sql).toContain("revision bigint not null");
    expect(sql).toContain("mail_drafts_idempotency_idx");
    expect(sql).toContain("attachment_object_ids uuid[]");
    expect(sql).toContain("expires_at timestamptz");
    expect(sql).toContain("helix_expire_mail_drafts");
    expect(sql).toContain("for update skip locked");
  });
});
