import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("./0108_mailbox_actor_rls.sql", import.meta.url), "utf8");

describe("0108 mailbox actor RLS migration", () => {
  it("gives attachments tenant identity and scopes every mail primitive by mailbox", () => {
    expect(migration).toContain("message_attachments add column if not exists org_id uuid");
    expect(migration).toContain("message_attachments_message_org_fk");
    expect(migration).toContain("message_attachments_object_org_fk");
    for (const table of [
      "threads",
      "messages",
      "message_attachments",
      "objects",
      "mail_message_identities",
      "mail_raw_sources",
      "mail_message_deliveries",
      "mail_thread_state",
    ]) {
      expect(migration).toContain(`create policy helix_tenant_isolation on ${table}`);
    }
    expect(migration).toContain("helix_can_access_mailbox");
    expect(migration).toContain("helix_can_read_mail_message");
    expect(migration).toContain("canonical mail content is immutable");
  });

  it("allows only active owner-issued manager delegation", () => {
    expect(migration).toContain("permission.resource_type = 'mailbox'");
    expect(migration).toContain("permission.role = 'manager'");
    expect(migration).toContain("permission.valid_from <= statement_timestamp()");
    expect(migration).toContain("permission.revoked_at is null");
    expect(migration).toContain("new.granted_by_actor_id is distinct from new.resource_id");
    expect(migration).toContain("permissions_active_mailbox_delegate_idx");
  });
});
