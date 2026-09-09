import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0094 chat permission validity migration", () => {
  it("models and centralizes every grant-validity dimension", async () => {
    const migration = await readFile(
      new URL("./0094_chat_permission_validity.sql", import.meta.url),
      "utf8",
    );

    for (const fragment of [
      "status text not null default 'active'",
      "add column if not exists valid_from timestamptz",
      "alter column valid_from set default now()",
      "revoked_at timestamptz",
      "revocation_epoch bigint not null default 0",
      "permissions_subject_org_fk",
      "permissions_grantor_org_fk",
      "require_valid_chat_permission_scope",
      "chat_permission_is_valid",
      "grant_row.org_id = expected_org_id",
      "grant_row.actor_id = expected_actor_id",
      "grant_row.resource_type = 'thread'",
      "grant_row.resource_id = expected_room_id",
      "grant_row.role in ('owner', 'moderator', 'member')",
      "grant_row.status = 'active'",
      "grant_row.valid_from <= statement_timestamp()",
      "grant_row.expires_at > statement_timestamp()",
      "grant_row.revoked_at is null",
      "grant_row.revocation_epoch = 0",
      "subject.disabled_at is null",
      "grantor.id = grant_row.granted_by_actor_id",
      "room.kind in ('chat_room', 'chat_dm')",
    ]) {
      expect(migration).toContain(fragment);
    }
  });
});
