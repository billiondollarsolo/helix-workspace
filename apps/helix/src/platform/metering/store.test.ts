import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresMeteringEventStore, PostgresMeteringRollupStore } from "./store.js";

const orgId = "11111111-1111-4111-8111-111111111111";

describe("PostgresMeteringEventStore", () => {
  it("inserts events into metering_events with JSON metadata", async () => {
    const recording = createRecordingSql();
    const store = new PostgresMeteringEventStore(recording.sql);

    const record = await store.insertEvent({
      orgId,
      eventType: "api.call.billable",
      quantity: "1",
      metadata: { route: "/api/tools" },
      occurredAt: new Date("2026-05-24T12:00:00.000Z"),
    });

    expect(record).toEqual({
      id: "event-1",
      orgId,
      eventType: "api.call.billable",
      quantity: "1",
      metadata: { route: "/api/tools" },
      occurredAt: "2026-05-24T12:00:00.000Z",
    });
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.text).toContain("insert into metering_events");
    expect(recording.calls[0]?.text).toContain("quantity::text as quantity");
    expect(recording.calls[0]?.values).toEqual([
      orgId,
      "api.call.billable",
      "1",
      { route: "/api/tools" },
      new Date("2026-05-24T12:00:00.000Z"),
    ]);
  });
});

describe("PostgresMeteringRollupStore", () => {
  it("recomputes affected completed periods and marks source events rolled up", async () => {
    const recording = createRecordingRollupSql();
    const store = new PostgresMeteringRollupStore(recording.sql);
    const cutoff = new Date("2026-05-24T00:00:00.000Z");

    const result = await store.rollupCompletedPeriods({ cutoff, periodLimit: 25 });

    expect(result).toEqual({ periodCount: 2, rollupCount: 3, eventCount: 7 });
    expect(recording.calls).toHaveLength(1);
    const query = recording.calls[0];
    expect(query?.text).toContain("candidate_periods as");
    expect(query?.text).toContain("rolled_up_at is null");
    expect(query?.text).toContain("occurred_at < ?");
    expect(query?.text).toContain("when 'ai.tokens' then 'ai_tokens'");
    expect(query?.text).toContain("when 'ai.image.generated' then 'ai_images_generated'");
    expect(query?.text).toContain("when 'storage.delta' then 'storage_delta_bytes'");
    expect(query?.text).toContain("when 'seats.delta' then 'seats_delta'");
    expect(query?.text).toContain("when 'export.completed' then 'exports_count'");
    expect(query?.text).toContain("when 'collab.session.opened' then 'collab_session_seconds'");
    expect(query?.text).toContain("when 'api.call.billable' then 'api_calls_billable'");
    expect(query?.text).toContain("storage_baselines as");
    expect(query?.text).toContain("'storage_avg_bytes' as metric_key");
    expect(query?.text).toContain("'daily_average_from_deltas'");
    expect(query?.text).toContain("seat_baselines as");
    expect(query?.text).toContain("'seats_max' as metric_key");
    expect(query?.text).toContain("'daily_max_from_deltas'");
    expect(query?.text).toContain("union all select * from storage_daily");
    expect(query?.text).toContain("union all select * from seats_daily");
    expect(query?.text).toContain("'metering_events_v1'");
    expect(query?.text).toContain("insert into metering_rollups");
    expect(query?.text).toContain("on conflict (org_id, period_start, metric_key)");
    expect(query?.text).toContain("do update set");
    expect(query?.text).toContain("update metering_events events");
    expect(query?.values).toEqual([cutoff, 25]);
  });
});

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function createRecordingSql(): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve([
      {
        id: "event-1",
        org_id: orgId,
        event_type: "api.call.billable",
        quantity: "1",
        metadata: values[3],
        occurred_at: new Date("2026-05-24T12:00:00.000Z"),
        rolled_up_at: null,
      },
    ]);
  };
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
  }) as unknown as postgres.Sql;
  return { sql, calls };
}

function createRecordingRollupSql(): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve([
      {
        period_count: 2,
        rollup_count: 3,
        event_count: 7,
      },
    ]);
  };
  return {
    sql: Object.assign(tag, {
      json: (value: unknown) => value,
    }) as unknown as postgres.Sql,
    calls,
  };
}
