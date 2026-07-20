import { describe, expect, it } from "vitest";
import { CHAT_MESSAGE_PAGE_SIZE, chatMessageListInfiniteQueryOptions } from "./queries";

describe("chat message infinite query", () => {
  it("getNextPageParam returns the oldest message sentAt when a full page is returned", () => {
    const opts = chatMessageListInfiniteQueryOptions("11111111-1111-4111-8111-111111111111");
    const page = Array.from({ length: CHAT_MESSAGE_PAGE_SIZE }, (_, i) => ({
      id: `m${String(i)}`,
      roomId: "11111111-1111-4111-8111-111111111111",
      actorId: null,
      body: "x",
      bodyFormat: "plain",
      attachmentObjectIds: [] as string[],
      metadata: {},
      sentAt: `2026-07-18T00:00:${String(i).padStart(2, "0")}.000Z`,
      editedAt: null,
      deletedAt: null,
      orgId: "22222222-2222-4222-8222-222222222222",
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    }));
    const next = opts.getNextPageParam(page, [page], undefined, [undefined]);
    expect(next).toBe(page[page.length - 1]?.sentAt);
  });

  it("getNextPageParam returns undefined when the page is short", () => {
    const opts = chatMessageListInfiniteQueryOptions("11111111-1111-4111-8111-111111111111");
    const page = [
      {
        id: "m1",
        roomId: "11111111-1111-4111-8111-111111111111",
        actorId: null,
        body: "x",
        bodyFormat: "plain",
        attachmentObjectIds: [] as string[],
        metadata: {},
        sentAt: "2026-07-18T00:00:00.000Z",
        editedAt: null,
        deletedAt: null,
        orgId: "22222222-2222-4222-8222-222222222222",
        createdAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
    ];
    expect(opts.getNextPageParam(page, [page], undefined, [undefined])).toBeUndefined();
  });
});
