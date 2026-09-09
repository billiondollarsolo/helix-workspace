import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0144 governed Chat spaces", () => {
  it("defines closed room governance and one history/retention authorization predicate", async () => {
    const migration = await readFile(
      new URL("./0144_chat_governed_spaces.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("'conversation', 'direct', 'announcement', 'project'");
    expect(migration).toContain("'full', 'since_join', 'off'");
    expect(migration).toContain("'internal', 'guests', 'federated'");
    expect(migration).toContain("helix_chat_message_visible_to");
    expect(migration).toContain("input_sent_at >= permission.valid_from");
    expect(migration).toContain("make_interval(days =>");
    expect(migration).toContain("legalHold");

    const replayStore = await readFile(
      new URL("../../platform/chat/realtime-event-store.ts", import.meta.url),
      "utf8",
    );
    expect(replayStore).toContain("historyPolicy");
    expect(replayStore).toContain("helix_chat_message_visible_to");
  });
});
