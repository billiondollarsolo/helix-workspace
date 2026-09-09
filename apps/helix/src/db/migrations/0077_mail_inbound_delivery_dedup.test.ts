import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("./0077_mail_inbound_delivery_dedup.sql", import.meta.url);
const rollbackUrl = new URL("./rollbacks/0077_mail_inbound_delivery_dedup.sql", import.meta.url);

describe("0077 inbound delivery dedup migration", () => {
  it("persists one durable dedup record per organization and tenant-safe recipients", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration).toContain("create table if not exists mail_inbound_deliveries");
    expect(migration).toContain("create table if not exists mail_inbound_recipients");
    expect(migration).toMatch(/mail_inbound_deliveries_org_dedup_idx[\s\S]+org_id, dedup_key/u);
    expect(migration).toContain("normalized_message_id text");
    expect(migration).toContain("raw_sha256 text not null");
    expect(migration).toContain("envelope_to text[] not null");
    expect(migration).toContain("mail_inbound_recipients_same_org");
    expect(migration).toContain("alter table mail_inbound_deliveries enable row level security");
    expect(migration).toContain("alter table mail_inbound_recipients enable row level security");
  });

  it("ships an explicit rollback outside the forward stream", async () => {
    const rollback = await readFile(rollbackUrl, "utf8");
    expect(rollback).toContain("refusing 0077 rollback");
    expect(rollback).toContain("drop trigger if exists mail_inbound_recipients_same_org");
    expect(rollback).toContain("drop table if exists mail_inbound_recipients");
    expect(rollback).toContain("drop table if exists mail_inbound_deliveries");
  });
});
