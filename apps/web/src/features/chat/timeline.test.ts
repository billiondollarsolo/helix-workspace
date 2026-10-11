import { describe, expect, it } from "vitest";
import { buildChatTimeline, chatDayLabel, firstUnreadMessageId } from "./timeline";
import type { ChatMessageView } from "./view-model";

const now = new Date(2026, 2, 5, 15, 0);

function message(id: string, actorId: string, sentAt: Date, isMine = false): ChatMessageView {
  return {
    id,
    actorId,
    authorName: actorId,
    sentAt: sentAt.toISOString(),
    time: "",
    body: id,
    bodyFormat: "plain",
    attachmentObjectIds: [],
    attachments: [],
    isMine,
    editedAt: null,
    reactions: [],
    replyCount: 0,
    lastReplyAt: null,
    pinned: false,
    readBy: 0,
  };
}

describe("chatDayLabel", () => {
  it("names today and yesterday, and spells out older dates", () => {
    expect(chatDayLabel(new Date(2026, 2, 5, 9, 0), now, "en-GB")).toBe("Today");
    expect(chatDayLabel(new Date(2026, 2, 4, 23, 59), now, "en-GB")).toBe("Yesterday");
    expect(chatDayLabel(new Date(2026, 2, 2, 10, 0), now, "en-GB")).toBe("Monday 2 March");
    expect(chatDayLabel(new Date(2025, 11, 31, 10, 0), now, "en-GB")).toBe(
      "Wednesday, 31 December 2025",
    );
  });
});

describe("buildChatTimeline", () => {
  it("groups one sender's messages within five minutes and breaks on a new day", () => {
    const items = buildChatTimeline(
      [
        message("a1", "ana", new Date(2026, 2, 4, 10, 0)),
        message("a2", "ana", new Date(2026, 2, 4, 10, 4)),
        message("a3", "ana", new Date(2026, 2, 4, 10, 10)),
        message("b1", "ben", new Date(2026, 2, 4, 10, 11)),
        message("b2", "ben", new Date(2026, 2, 5, 9, 0)),
      ],
      { now, locale: "en-GB" },
    );
    expect(
      items.map((item) =>
        item.kind === "message" ? `${item.key}${item.grouped ? "+" : ""}` : item.kind,
      ),
    ).toEqual(["day", "a1", "a2+", "a3", "b1", "day", "b2"]);
    expect(items[0]).toMatchObject({ kind: "day", label: "Yesterday" });
    expect(items[5]).toMatchObject({ kind: "day", label: "Today" });
  });

  it("puts the Unread divider before the first unread message and restarts the run", () => {
    const items = buildChatTimeline(
      [
        message("a1", "ana", new Date(2026, 2, 5, 10, 0)),
        message("a2", "ana", new Date(2026, 2, 5, 10, 1)),
      ],
      { now, firstUnreadId: "a2" },
    );
    expect(items.map((item) => item.kind)).toEqual(["day", "message", "unread", "message"]);
    expect(items[3]).toMatchObject({ kind: "message", grouped: false });
  });
});

describe("firstUnreadMessageId", () => {
  it("finds the first message from someone else after the read marker", () => {
    const messages = [
      message("old", "ana", new Date(2026, 2, 5, 9, 0)),
      message("mine", "me", new Date(2026, 2, 5, 9, 30), true),
      message("new", "ana", new Date(2026, 2, 5, 9, 45)),
    ];
    expect(firstUnreadMessageId(messages, new Date(2026, 2, 5, 9, 10).toISOString())).toBe("new");
    expect(firstUnreadMessageId(messages, new Date(2026, 2, 5, 10, 0).toISOString())).toBeNull();
    expect(firstUnreadMessageId(messages, null)).toBe("old");
  });
});
