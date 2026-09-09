import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0085 chat read-receipt integrity migration", () => {
  it("assigns per-room message positions and stores receipt privacy and progress", async () => {
    const migration = await readFile(
      new URL("./0085_chat_read_receipt_integrity.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("read_receipts_enabled boolean not null default true");
    expect(migration).toContain("next_message_sequence bigint not null default 0");
    expect(migration).toContain("partition by thread_id order by sent_at, id");
    expect(migration).toContain("messages_chat_room_sequence_uidx");
    expect(migration).toContain("assign_chat_room_message_sequence");
    expect(migration).toContain("last_read_sequence bigint");
    expect(migration).toContain("message.org_id = receipt.org_id");
    expect(migration).toContain("message.thread_id = receipt.thread_id");
  });
});
