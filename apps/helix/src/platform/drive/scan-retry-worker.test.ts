import { describe, expect, it, vi } from "vitest";
import { DriveVirusScanRetryWorker } from "./scan-retry-worker.js";

describe("DriveVirusScanRetryWorker", () => {
  it("runs one bounded batch at a time and reports the result", async () => {
    let finish:
      | ((value: { claimed: number; completed: number; failed: number }) => void)
      | undefined;
    const runVirusScanRetryBatch = vi.fn(
      () =>
        new Promise<{ claimed: number; completed: number; failed: number }>((resolve) => {
          finish = resolve;
        }),
    );
    const onResult = vi.fn();
    const worker = new DriveVirusScanRetryWorker({
      store: { runVirusScanRetryBatch },
      intervalMs: 60_000,
      batchSize: 7,
      leaseMs: 30_000,
      onResult,
    });

    const first = worker.runOnce();
    const second = worker.runOnce();
    expect(runVirusScanRetryBatch).toHaveBeenCalledTimes(1);
    expect(runVirusScanRetryBatch).toHaveBeenCalledWith({ limit: 7, leaseMs: 30_000 });
    finish?.({ claimed: 2, completed: 1, failed: 1 });
    await expect(first).resolves.toEqual({ claimed: 2, completed: 1, failed: 1 });
    await expect(second).resolves.toEqual({ claimed: 2, completed: 1, failed: 1 });
    expect(onResult).toHaveBeenCalledOnce();
  });

  it("keeps quarantine cleanup running without allowing no-op antivirus retries", async () => {
    const runVirusScanRetryBatch = vi.fn(async () => ({ claimed: 0, completed: 0, failed: 0 }));
    const worker = new DriveVirusScanRetryWorker({
      store: { runVirusScanRetryBatch },
      intervalMs: 60_000,
      batchSize: 7,
      leaseMs: 30_000,
      virusScansEnabled: false,
    });

    await worker.runOnce();

    expect(runVirusScanRetryBatch).toHaveBeenCalledWith({
      limit: 7,
      leaseMs: 30_000,
      includeVirusScans: false,
    });
  });
});
