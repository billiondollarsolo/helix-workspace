import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("./0158_mail_dkim_kms.sql", import.meta.url), "utf8");

describe("0158 mail DKIM KMS migration", () => {
  it("invalidates legacy PEM envelopes and enforces KMS-backed lifecycle state", () => {
    expect(migration).toContain("create type mail_dkim_key_status as enum ('pending'");
    expect(migration).toContain("delete from mail_dkim_keys where kms_key_id is null");
    expect(migration).toContain("alter column kms_key_id set not null");
    expect(migration).toContain("mail_dkim_keys_lifecycle_check");
  });
});
