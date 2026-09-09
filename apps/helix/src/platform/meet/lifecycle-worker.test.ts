import { describe, expect, it, vi } from "vitest";
import { MeetLifecycleWorker } from "./lifecycle-worker.js";

describe("MeetLifecycleWorker", () => {
  it("ends rooms empty beyond the grace period and coalesces concurrent runs", async () => {
    const expireEmptyRooms = vi.fn(async () => 2);
    const onResult = vi.fn();
    const worker = new MeetLifecycleWorker({
      store: { expireEmptyRooms },
      now: () => new Date("2026-09-02T12:00:00.000Z"),
      emptyTimeoutMs: 120_000,
      batchSize: 25,
      onResult,
    });

    const [left, right] = await Promise.all([worker.runOnce(), worker.runOnce()]);

    expect([left, right]).toEqual([2, 2]);
    expect(expireEmptyRooms).toHaveBeenCalledTimes(1);
    expect(expireEmptyRooms).toHaveBeenCalledWith({
      emptyBefore: new Date("2026-09-02T11:58:00.000Z"),
      limit: 25,
    });
    expect(onResult).toHaveBeenCalledWith(2);
  });
});
