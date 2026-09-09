import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("./0080_chat_tenant_integrity.sql", import.meta.url);
const rollbackUrl = new URL("./rollbacks/0080_chat_tenant_integrity.sql", import.meta.url);

describe("0080 Chat tenant integrity migration", () => {
  it("enforces tenant-scoped membership and every Chat relation", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("chat_thread_membership_unique");
    expect(sql).toContain("where resource_type = 'thread'");
    expect(sql).toContain("foreign key (org_id, actor_id)");
    expect(sql).toContain("foreign key (org_id, thread_id, message_id)");
    expect(sql).toContain("foreign key (org_id, thread_id, last_read_message_id)");
    expect(sql.match(/not valid/giu)?.length).toBeGreaterThanOrEqual(9);
  });

  it("provides an explicit rollback for each added constraint and index", async () => {
    const [migration, rollback] = await Promise.all([
      readFile(migrationUrl, "utf8"),
      readFile(rollbackUrl, "utf8"),
    ]);
    for (const name of migration.match(/(?:constraint|index if not exists)\s+(\w+)/giu) ?? []) {
      const identifier = name.split(/\s+/u).at(-1);
      expect(rollback).toContain(identifier);
    }
  });
});
