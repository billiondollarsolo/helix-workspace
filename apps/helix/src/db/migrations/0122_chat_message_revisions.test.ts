import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("./0122_chat_message_revisions.sql", import.meta.url),
  "utf8",
);

describe("0122 chat message revisions", () => {
  it("captures immutable tenant-scoped history before edits and deletion", () => {
    expect(migration).toContain("create table if not exists chat_message_revisions");
    expect(migration).toContain("before update of body, body_format, deleted_at on messages");
    expect(migration).toContain("old.chat_revision");
    expect(migration).toContain("force row level security");
    expect(migration).toContain("revoke update, delete, truncate");
  });
});
