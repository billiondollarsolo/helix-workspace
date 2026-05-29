import { describe, expect, it } from "vitest";
import { bucketThreadsByDate } from "./date-buckets";
import type { AssistantThread } from "./assistant-data";

// Frozen "now" used for every test — keeps the bucket boundaries
// deterministic regardless of when the suite runs.
const NOW = Date.parse("2026-05-27T14:30:00-04:00");

function thread(id: string, daysAgo: number, pinned = false): AssistantThread {
  const updatedAtMs = NOW - daysAgo * 24 * 60 * 60 * 1000;
  return {
    id,
    title: `Thread ${id}`,
    time: `${String(daysAgo)}d`,
    updatedAtMs,
    ...(pinned ? { pinned: true } : {}),
  };
}

describe("bucketThreadsByDate", () => {
  it("returns an empty list for no threads", () => {
    expect(bucketThreadsByDate([], NOW)).toEqual([]);
  });

  it("groups today's threads under a Today header", () => {
    const items = bucketThreadsByDate([thread("a", 0)], NOW);
    expect(items.map((item) => (item.kind === "header" ? item.label : item.thread.id))).toEqual([
      "Today",
      "a",
    ]);
  });

  it("separates Today from Yesterday using local midnight", () => {
    const items = bucketThreadsByDate(
      [thread("today", 0), thread("yest", 1)],
      NOW,
    );
    const labels = items
      .filter((item) => item.kind === "header")
      .map((item) => (item as { label: string }).label);
    expect(labels).toEqual(["Today", "Yesterday"]);
  });

  it("places 6-day-old threads under Previous 7 Days", () => {
    const items = bucketThreadsByDate([thread("x", 6)], NOW);
    expect((items[0] as { label: string }).label).toBe("Previous 7 Days");
  });

  it("places 20-day-old threads under Previous 30 Days", () => {
    const items = bucketThreadsByDate([thread("x", 20)], NOW);
    expect((items[0] as { label: string }).label).toBe("Previous 30 Days");
  });

  it("groups older threads into per-month buckets, most recent first", () => {
    // ~45 days ago → April 2026; ~90 days ago → late February 2026.
    const items = bucketThreadsByDate(
      [thread("apr", 45), thread("feb", 90)],
      NOW,
    );
    const headers = items
      .filter((item) => item.kind === "header")
      .map((item) => (item as { label: string }).label);
    expect(headers[0]).toMatch(/April 2026|March 2026/u);
    expect(headers[1]).toMatch(/February 2026|January 2026/u);
  });

  it("buckets threads with no/zero timestamp under Older at the end", () => {
    const items = bucketThreadsByDate(
      [thread("today", 0), { ...thread("ghost", 0), updatedAtMs: 0 }],
      NOW,
    );
    const labels = items
      .filter((item) => item.kind === "header")
      .map((item) => (item as { label: string }).label);
    expect(labels[labels.length - 1]).toBe("Older");
  });

  it("preserves caller's order within a bucket", () => {
    const items = bucketThreadsByDate(
      [thread("a", 0), thread("b", 0), thread("c", 0)],
      NOW,
    );
    const ids = items
      .filter((item) => item.kind === "thread")
      .map((item) => (item as { thread: AssistantThread }).thread.id);
    expect(ids).toEqual(["a", "b", "c"]);
  });
});
