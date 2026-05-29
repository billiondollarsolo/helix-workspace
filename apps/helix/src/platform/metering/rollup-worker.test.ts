import { describe, expect, it } from "vitest";
import { MeteringRollupWorker, startOfUtcDay } from "./rollup-worker.js";
import type {
  MeteringRollupRunInput,
  MeteringRollupRunResult,
  MeteringRollupStore,
} from "./store.js";

describe("MeteringRollupWorker", () => {
  it("rolls up completed UTC days before the current day", async () => {
    const store = new RecordingRollupStore({
      periodCount: 1,
      rollupCount: 2,
      eventCount: 3,
    });
    const worker = new MeteringRollupWorker({
      store,
      periodBatchSize: 50,
      now: sequenceClock([
        new Date("2026-05-24T13:45:00.000Z"),
        new Date("2026-05-24T13:45:01.000Z"),
      ]),
    });

    const result = await worker.runOnce();

    expect(store.inputs).toEqual([
      {
        cutoff: new Date("2026-05-24T00:00:00.000Z"),
        periodLimit: 50,
      },
    ]);
    expect(result).toEqual({
      startedAt: "2026-05-24T13:45:00.000Z",
      completedAt: "2026-05-24T13:45:01.000Z",
      cutoff: "2026-05-24T00:00:00.000Z",
      periodCount: 1,
      rollupCount: 2,
      eventCount: 3,
    });
  });

  it("calculates UTC day starts", () => {
    expect(startOfUtcDay(new Date("2026-05-24T23:59:59.999Z")).toISOString()).toBe(
      "2026-05-24T00:00:00.000Z",
    );
  });
});

class RecordingRollupStore implements MeteringRollupStore {
  readonly inputs: MeteringRollupRunInput[] = [];

  constructor(private readonly result: MeteringRollupRunResult) {}

  async rollupCompletedPeriods(input: MeteringRollupRunInput): Promise<MeteringRollupRunResult> {
    this.inputs.push(input);
    return this.result;
  }
}

function sequenceClock(values: readonly Date[]): () => Date {
  let index = 0;
  return () =>
    values[Math.min(index++, values.length - 1)] ?? values[values.length - 1] ?? new Date();
}
