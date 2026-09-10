import { describe, expect, it, vi } from "vitest";
import { createRecordingSql } from "../../test-support/recording-sql.js";
import { MailTrashPurgeWorker, PostgresMailTrashPurger } from "./retention.js";

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

describe("PostgresMailTrashPurger", () => {
  it("uses the database clock by default and preserves explicit cutoffs for database validation", async () => {
    const recording = createRecordingSql();
    const purger = new PostgresMailTrashPurger(recording.sql);
    await purger.runBatch();
    expect(recording.calls).toHaveLength(2);
    for (const query of recording.calls) {
      expect(query.text).toContain("coalesce(?::timestamptz, statement_timestamp())");
      expect(query.values).toEqual([100, null]);
    }

    const explicitCutoff = new Date("2099-01-01T00:00:00Z");
    await purger.runBatch(600, explicitCutoff);
    expect(recording.calls).toHaveLength(4);
    for (const query of recording.calls.slice(2)) {
      expect(query.values).toEqual([500, explicitCutoff]);
    }
  });
});
