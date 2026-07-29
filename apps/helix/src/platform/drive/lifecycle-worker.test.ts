import { describe, expect, it, vi } from "vitest";
import { DriveLifecycleGcWorker } from "./lifecycle-worker.js";

describe("Drive lifecycle GC worker", () => {
  it("uses bounded configured batches and grace cutoffs", async () => {
    const collectOrphans = vi.fn().mockResolvedValue({ candidates: 2, collected: 2 });
    const onResult = vi.fn();
    const worker = new DriveLifecycleGcWorker({
      store: { collectOrphans },
      intervalMs: 60_000,
      orphanGraceHours: 24,
      batchSize: 50,
      now: () => new Date("2026-07-28T12:00:00.000Z"),
      onResult,
    });

    await worker.runOnce();

    expect(collectOrphans).toHaveBeenCalledWith({
      olderThan: new Date("2026-07-27T12:00:00.000Z"),
      dryRun: false,
      limit: 50,
    });
    expect(onResult).toHaveBeenCalledWith({ candidates: 2, collected: 2 });
  });
});
