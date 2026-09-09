import { describe, expect, it, vi } from "vitest";
import { MailTrashPurgeWorker } from "./retention.js";

describe("MailTrashPurgeWorker", () => {
  it("coalesces overlapping ticks into one bounded singleton run", async () => {
    let finish:
      | ((value: {
          purgedMailboxes: number;
          purgedThreads: number;
          queuedObjects: number;
          purgedJournalEntries: number;
        }) => void)
      | undefined;
    const runBatch = vi.fn(
      () =>
        new Promise<{
          purgedMailboxes: number;
          purgedThreads: number;
          queuedObjects: number;
          purgedJournalEntries: number;
        }>((resolve) => {
          finish = resolve;
        }),
    );
    const worker = new MailTrashPurgeWorker({ runBatch });
    const first = worker.runOnce();
    const second = worker.runOnce();
    expect(second).toBe(first);
    expect(runBatch).toHaveBeenCalledTimes(1);
    finish?.({
      purgedMailboxes: 1,
      purgedThreads: 1,
      queuedObjects: 2,
      purgedJournalEntries: 3,
    });
    await expect(first).resolves.toEqual({
      purgedMailboxes: 1,
      purgedThreads: 1,
      queuedObjects: 2,
      purgedJournalEntries: 3,
    });
  });
});
