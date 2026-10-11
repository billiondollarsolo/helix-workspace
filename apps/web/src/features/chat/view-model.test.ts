import { describe, expect, it } from "vitest";
import {
  conversationViews,
  homeFeed,
  reactionViews,
  readCountFor,
  seenByForMessage,
  seenMarkers,
} from "./view-model";
import type { ChatReadReceiptRecord, ChatRoomRecord } from "./api";

const ordered = ["m1", "m2", "m3"];
const self = "self";

const receipts: readonly ChatReadReceiptRecord[] = [
  {
    roomId: "r1",
    actorId: "a",
    orgId: "o",
    lastReadMessageId: "m2",
    lastReadAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  },
  {
    roomId: "r1",
    actorId: "b",
    orgId: "o",
    lastReadMessageId: "m3",
    lastReadAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  },
  {
    roomId: "r1",
    actorId: self,
    orgId: "o",
    lastReadMessageId: "m3",
    lastReadAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  },
];

describe("read receipts as seen-by markers", () => {
  it("counts others who have read through a message", () => {
    expect(readCountFor("m1", ordered, receipts, self)).toBe(2);
    expect(readCountFor("m2", ordered, receipts, self)).toBe(2);
    expect(readCountFor("m3", ordered, receipts, self)).toBe(1);
  });

  it("does not include self in seen-by lists", () => {
    expect(seenByForMessage("m3", ordered, receipts, self)).toEqual(["b"]);
    expect(seenByForMessage("m3", ordered, receipts, self)).not.toContain(self);
  });

  it("places markers after the correct last-read messages", () => {
    const markers = seenMarkers(ordered, receipts, self);
    expect(markers).toEqual(
      expect.arrayContaining([
        { afterMessageId: "m2", actorIds: ["a"] },
        { afterMessageId: "m3", actorIds: ["b"] },
      ]),
    );
    expect(markers.every((m) => !m.actorIds.includes(self))).toBe(true);
  });
});

describe("reaction projections", () => {
  it("aggregates server reactions and marks the current actor's reaction", () => {
    const createdAt = "2026-07-18T00:00:00.000Z";
    expect(
      reactionViews(
        [
          { messageId: "m1", actorId: self, emoji: "✅", createdAt },
          { messageId: "m1", actorId: "peer", emoji: "✅", createdAt },
          { messageId: "m1", actorId: "peer", emoji: "🎉", createdAt },
        ],
        self,
      ),
    ).toEqual([
      { emoji: "✅", count: 2, mine: true },
      { emoji: "🎉", count: 1, mine: false },
    ]);
  });
});

describe("conversation rows", () => {
  const member = (actorId: string, displayName: string) => ({
    actorId,
    role: "member" as const,
    displayName,
    email: `${actorId}@example.com`,
  });
  const base = {
    orgId: "o",
    createdByActorId: null,
    metadata: {},
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  };
  const rooms: ChatRoomRecord[] = [
    {
      ...base,
      id: "dm",
      kind: "chat_dm",
      subject: "legacy subject",
      members: [member(self, "Me"), member("ana", "Ana Ruiz")],
      settings: null,
    },
    {
      ...base,
      id: "group",
      kind: "chat_dm",
      subject: null,
      members: [member(self, "Me"), member("ana", "Ana Ruiz"), member("bo", "Bo Lin")],
      settings: null,
    },
    {
      ...base,
      id: "space",
      kind: "chat_room",
      subject: "Launch",
      members: [member(self, "Me")],
      settings: null,
    },
  ];

  it("names DMs after the other people and carries unread counts", () => {
    const views = conversationViews(
      rooms,
      self,
      [
        {
          roomId: "space",
          unreadCount: 4,
          mentionCount: 1,
          lastMessageAt: "2026-07-18T09:00:00.000Z",
          lastReadAt: null,
        },
        {
          roomId: "dm",
          unreadCount: 0,
          mentionCount: 0,
          lastMessageAt: "2026-07-18T10:00:00.000Z",
          lastReadAt: null,
        },
      ],
      new Map([["ana", true]]),
    );
    expect(views.map((view) => [view.name, view.kind, view.unread, view.active])).toEqual([
      ["Ana Ruiz", "dm", 0, true],
      ["Ana Ruiz and Bo Lin", "dm", 0, false],
      ["Launch", "space", 4, false],
    ]);
    expect(views[1]?.peer).toBeNull();
    // Home: unread first, then most recently active.
    expect(homeFeed(views).map((view) => view.id)).toEqual(["space", "dm", "group"]);
  });
});
