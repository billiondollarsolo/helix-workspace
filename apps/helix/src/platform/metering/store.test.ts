import { describe, expect, it } from "vitest";
import { createRecordingSql as sharedRecordingSql } from "../../test-support/recording-sql.js";
import { PostgresMeteringEventStore } from "./store.js";

const orgId = "11111111-1111-4111-8111-111111111111";

describe("PostgresMeteringEventStore", () => {
  it("inserts events into metering_events with JSON metadata", async () => {
    const recording = createRecordingSql();
    const store = new PostgresMeteringEventStore(recording.sql);

    const record = await store.insertEvent({
      orgId,
      eventType: "export.completed",
      quantity: "1",
      metadata: { jobId: "export-1" },
      occurredAt: new Date("2026-05-24T12:00:00.000Z"),
    });

    expect(record).toEqual({
      id: "event-1",
      orgId,
      eventType: "export.completed",
      quantity: "1",
      metadata: { jobId: "export-1" },
      occurredAt: "2026-05-24T12:00:00.000Z",
    });
    expect(recording.beginCalls).toBe(1);
    expect(recording.calls).toHaveLength(2);
    expect(recording.calls[0]?.text).toContain("set_config('helix.org_id'");
    expect(recording.calls[0]?.values).toEqual([orgId, ""]);
    expect(recording.calls[1]?.text).toContain("insert into metering_events");
    expect(recording.calls[1]?.text).toContain("quantity::text as quantity");
    expect(recording.calls[1]?.values).toEqual([
      orgId,
      "export.completed",
      "1",
      { jobId: "export-1" },
      new Date("2026-05-24T12:00:00.000Z"),
    ]);
  });
});

function createRecordingSql() {
  const recording = sharedRecordingSql(({ values }) => {
    return Promise.resolve([
      {
        id: "event-1",
        org_id: orgId,
        event_type: "export.completed",
        quantity: "1",
        metadata: values[3],
        occurred_at: new Date("2026-05-24T12:00:00.000Z"),
        rolled_up_at: null,
      },
    ]);
  }, "?");
  return {
    ...recording,
    get transactions() {
      return recording.beginCalls;
    },
    get beginCalls() {
      return recording.beginCalls;
    },
  };
}
