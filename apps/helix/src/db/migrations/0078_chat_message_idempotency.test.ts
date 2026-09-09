import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("chat message idempotency migration", () => {
  it("persists and uniquely indexes the tenant, member, room, and client key", async () => {
    const migration = await readFile(
      new URL("./0078_chat_message_idempotency.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("add column if not exists client_message_id text");
    expect(migration).toContain("on messages (org_id, actor_id, thread_id, client_message_id)");
    expect(migration).toContain("where kind = 'chat' and client_message_id is not null");
  });
});
