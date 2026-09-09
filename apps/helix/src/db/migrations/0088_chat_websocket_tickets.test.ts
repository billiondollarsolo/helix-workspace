import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0088 chat websocket tickets migration", () => {
  it("stores only a tenant-bound digest with expiry and atomic-consumption state", async () => {
    const migration = await readFile(
      new URL("./0088_chat_websocket_tickets.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("token_hash text primary key");
    expect(migration).not.toMatch(/(^|\s)token text/mu);
    expect(migration).toContain("foreign key (org_id, actor_id)");
    expect(migration).toContain("foreign key (org_id, room_id)");
    expect(migration).toContain("audience text not null");
    expect(migration).toContain("path text not null");
    expect(migration).toContain("expires_at timestamptz not null");
    expect(migration).toContain("consumed_at timestamptz");
  });
});
