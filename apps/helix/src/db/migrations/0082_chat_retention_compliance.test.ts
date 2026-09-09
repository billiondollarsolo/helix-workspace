import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("./0082_chat_retention_compliance.sql", import.meta.url);
const rollbackUrl = new URL("./rollbacks/0082_chat_retention_compliance.sql", import.meta.url);

describe("0082 Chat retention compliance migration", () => {
  it("defines policies, dedupe, content-free tombstones, and attachment removal", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("chat_retention_policies");
    expect(sql).toContain("legal_hold boolean");
    expect(sql).toContain("chat_message_client_retry_unique");
    expect(sql).toContain("new.body := ''");
    expect(sql).toContain("new.metadata := jsonb_build_object('tombstone', true)");
    expect(sql).toContain("delete from message_attachments");
  });

  it("refuses rollback while compliance tombstones exist", async () => {
    const sql = await readFile(rollbackUrl, "utf8");
    expect(sql).toContain("refusing 0082 rollback");
    expect(sql).toContain("tombstoned_at is not null");
  });
});
