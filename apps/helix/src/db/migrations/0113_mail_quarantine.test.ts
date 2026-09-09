import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("./0113_mail_quarantine.sql", import.meta.url), "utf8");

describe("0113 inaccessible mail quarantine", () => {
  it("keeps quarantined bytes outside objects, messages, attachments, and mailbox deliveries", () => {
    expect(migration).toContain("create table mail_quarantines");
    expect(migration).toContain("storage_key text not null unique");
    expect(migration).not.toMatch(
      /insert into (objects|messages|message_attachments|mail_message_deliveries)/u,
    );
  });

  it("restricts reads and mutations to mail administrators or the mail service", () => {
    expect(migration).toContain("helix_can_read_mail_quarantine");
    expect(migration).toContain("helix_can_write_mail_quarantine");
    expect(migration).toContain("alter table mail_quarantines force row level security");
    expect(migration).toContain("revoke all on mail_quarantines from public, helix_readonly");
    expect(migration).toContain("'mail.admin'");
  });

  it("serializes release and delete with a reclaimable policy-check lease", () => {
    expect(migration).toContain("'rechecking'");
    expect(migration).toContain("release_token uuid");
    expect(migration).toContain("release_lease_expires_at timestamptz");
  });
});
