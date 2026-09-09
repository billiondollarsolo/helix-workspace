import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresCalendarStore } from "./store.js";

describe("Postgres calendar time intent", () => {
  it("keeps local wall time when only the event timezone changes", async () => {
    const current = eventRow("America/New_York", "2026-12-15T14:00:00.000Z");
    const updated = eventRow("America/Los_Angeles", "2026-12-15T17:00:00.000Z");
    const recording = recordingSql([[current], [], [updated], [], [], [], [], [updated], []]);
    const store = new PostgresCalendarStore(recording.sql);

    await store.updateEvent({
      orgId: current.org_id,
      actorId: current.organizer_actor_id,
      eventId: current.id,
      patch: { timezone: "America/Los_Angeles" },
    });

    const update = recording.calls.find((call) => call.query.includes("update cal_events"));
    expect(update?.values).toContainEqual(new Date("2026-12-15T17:00:00.000Z"));
    expect(update?.values).toContainEqual(new Date("2026-12-15T18:00:00.000Z"));
    expect(update?.values).toContain("America/Los_Angeles");
    expect(update?.values).toContain("2026-12-15T09:00:00");
  });
});

function eventRow(timezone: string, startsAt: string) {
  const start = new Date(startsAt);
  return {
    id: "44444444-4444-4444-8444-444444444444",
    org_id: "22222222-2222-4222-8222-222222222222",
    calendar_id: "33333333-3333-4333-8333-333333333333",
    thread_id: null,
    uid: "event@helix.local",
    title: "Planning",
    description: null,
    location: null,
    starts_at: start,
    ends_at: new Date(start.getTime() + 3_600_000),
    timezone,
    all_day: false,
    time_semantics: "zoned",
    starts_local: "2026-12-15T09:00:00",
    ends_local: "2026-12-15T10:00:00",
    status: "confirmed",
    recurrence_rule: null,
    organizer_actor_id: "11111111-1111-4111-8111-111111111111",
    organizer_email: "owner@example.com",
    ics_sequence: 1,
    metadata: {},
    deleted_at: null,
    created_at: start,
    updated_at: start,
  };
}

function recordingSql(responses: readonly (readonly unknown[])[]): {
  readonly sql: postgres.Sql;
  readonly calls: { readonly query: string; readonly values: readonly unknown[] }[];
} {
  const calls: { query: string; values: readonly unknown[] }[] = [];
  const queue = [...responses];
  const tag = (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
    calls.push({ query: strings.join("$"), values });
    return Promise.resolve(queue.shift() ?? []);
  };
  const sql = Object.assign(tag, {
    array: (value: unknown) => value,
    json: (value: unknown) => value,
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) =>
      callback(sql as unknown as postgres.TransactionSql),
  }) as unknown as postgres.Sql;
  return { sql, calls };
}
