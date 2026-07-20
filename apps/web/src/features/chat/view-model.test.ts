import { describe, expect, it } from "vitest";
import { readCountFor, seenByForMessage, seenMarkers } from "./view-model";
import type { ChatReadReceiptRecord } from "./api";

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
