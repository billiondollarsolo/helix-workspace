import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0099 Chat ordered events migration", () => {
  it("allocates tenant-scoped room cursors and durably fans out every append", async () => {
    const sql = await readFile(new URL("./0099_chat_ordered_events.sql", import.meta.url), "utf8");

    for (const fragment of [
      "next_event_sequence bigint not null default 0",
      "create table if not exists chat_room_events",
      "primary key (room_id, sequence)",
      "foreign key (org_id, room_id) references threads (org_id, id)",
      "alter table chat_room_events force row level security",
      "create unique index if not exists chat_room_events_message_created_idx",
      "create or replace function append_chat_room_event",
      "set next_event_sequence = next_event_sequence + 1",
      "insert into public.outbox (subject, payload)",
    ]) {
      expect(sql).toContain(fragment);
    }
  });
});
