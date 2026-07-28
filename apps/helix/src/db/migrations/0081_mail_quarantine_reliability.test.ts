import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("./0081_mail_quarantine_reliability.sql", import.meta.url);
const rollbackUrl = new URL("./rollbacks/0081_mail_quarantine_reliability.sql", import.meta.url);

describe("0081 mail quarantine and reliability migration", () => {
  it("adds durable quarantine, draft versions, and scoped send idempotency", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("create table if not exists mail_quarantined_messages");
    expect(sql).toContain("raw_message bytea");
    expect(sql).toContain("mail_quarantine_raw_lifecycle");
    expect(sql).toMatch(/mail_outbound_idempotency_idx[\s\S]+org_id, actor_id, idempotency_key/u);
    expect(sql).toContain("version integer not null default 1");
  });

  it("enforces tenant actors and RLS without exposing quarantined bytes elsewhere", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("mail_quarantine_release_actor_same_org");
    expect(sql).toContain("mail_quarantine_delete_actor_same_org");
    expect(sql).toContain("alter table mail_quarantined_messages enable row level security");
  });

  it("refuses rollback after durable evidence exists", async () => {
    const sql = await readFile(rollbackUrl, "utf8");
    expect(sql).toContain("refusing 0081 rollback");
    expect(sql).toContain("idempotency_key is not null");
    expect(sql).toContain("version > 1");
  });
});
