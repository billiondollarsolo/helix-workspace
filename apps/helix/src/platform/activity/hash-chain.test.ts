import { describe, expect, it } from "vitest";
import { ACTIVITY_CHAIN_ROOT, activityChainHash } from "./hash-chain.js";

const link = {
  prevHash: null,
  verb: "sheets.sheet.created",
  objectId: "2d5d52e5-0487-42b4-a0e1-9e8f3bc83d11",
  timestamp: 1_767_225_600_000,
};

describe("activityChainHash", () => {
  it("is a fixed-width digest", () => {
    expect(activityChainHash(link)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("stays the same width no matter how deep the chain is", () => {
    /* The bug this exists to prevent: the link used to be built by
       concatenating the previous value, so every row was longer than the last.
       `activity_hash_idx` is a unique btree on that column, and once a value
       passed ~2704 bytes Postgres refused the insert — taking down every
       operation that records activity, which is sheet, deck, document and
       event creation. */
    let previous: string | null = null;
    for (let depth = 0; depth < 500; depth += 1) {
      previous = activityChainHash({ ...link, prevHash: previous, timestamp: depth });
      expect(previous).toHaveLength(64);
    }
  });

  it("recovers from an oversized legacy value without a backfill", () => {
    /* Rows written before the fix hold multi-kilobyte strings. The first
       hashed row reads one as its predecessor and must still be bounded, or
       the fix would need a migration to take effect. */
    const legacy = `root:sheets.sheet.created:${"a".repeat(4000)}`;

    expect(activityChainHash({ ...link, prevHash: legacy })).toHaveLength(64);
  });

  it("commits to the previous link", () => {
    // Changing history has to change every digest after it, or the chain
    // proves nothing.
    const a = activityChainHash({ ...link, prevHash: "a".repeat(64) });
    const b = activityChainHash({ ...link, prevHash: "b".repeat(64) });

    expect(a).not.toBe(b);
  });

  it("distinguishes entries that differ only in verb, object, or time", () => {
    const base = activityChainHash(link);

    expect(activityChainHash({ ...link, verb: "sheets.sheet.deleted" })).not.toBe(base);
    expect(
      activityChainHash({ ...link, objectId: "00000000-0000-4000-8000-000000000001" }),
    ).not.toBe(base);
    expect(activityChainHash({ ...link, timestamp: link.timestamp + 1 })).not.toBe(base);
  });

  it("cannot be forged by shifting a delimiter across a field boundary", () => {
    /* Fields are newline-separated and no field can contain a newline, so
       "verb=a, object=b" and "verb=a\nb, object=<empty>" cannot collide. */
    const split = activityChainHash({ ...link, verb: "a", objectId: "b" });
    const shifted = activityChainHash({ ...link, verb: "a\nb", objectId: "" });

    expect(split).not.toBe(shifted);
  });

  it("treats a null predecessor as the chain root", () => {
    expect(activityChainHash({ ...link, prevHash: null })).toBe(
      activityChainHash({ ...link, prevHash: ACTIVITY_CHAIN_ROOT }),
    );
  });
});
