import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresCalendarStore } from "./store.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const otherOrgId = "99999999-9999-4999-8999-999999999999";
const actorId = "22222222-2222-4222-8222-222222222222";
const eventId = "33333333-3333-4333-8333-333333333333";
const calendarId = "44444444-4444-4444-8444-444444444444";

describe("Calendar negative-security / tenant isolation (CAL.2 / CAL.11)", () => {
  it("scopes getEventForActor by org_id and actor access predicates", async () => {
    const recording = recordingSql([[]]);
    const store = new PostgresCalendarStore(recording.sql);

    await expect(store.getEventForActor({ orgId, actorId, eventId })).resolves.toBeNull();

    const query = recording.calls[0] ?? "";
    expect(query).toContain("from cal_events");
    expect(query).toContain("e.org_id");
    expect(query).toContain("e.deleted_at is null");
    expect(query).toMatch(/owner_actor_id|organizer_actor_id|cal_attendees|permissions/);
    expect(recording.values[0]).toEqual(expect.arrayContaining([eventId, orgId, actorId]));
    expect(recording.values[0]).not.toContain(otherOrgId);
  });

  it("scopes listCalendarEventsForActor by org_id", async () => {
    const recording = recordingSql([[]]);
    const store = new PostgresCalendarStore(recording.sql);

    await expect(
      store.listCalendarEventsForActor({
        orgId,
        actorId,
        calendarId,
        startsAt: new Date("2026-05-20T00:00:00.000Z"),
        endsAt: new Date("2026-05-21T00:00:00.000Z"),
        limit: 10,
      }),
    ).resolves.toEqual([]);

    const query = recording.calls.join("\n");
    expect(query).toContain("org_id");
    expect(recording.values.some((values) => values.includes(orgId))).toBe(true);
    expect(recording.values.flat()).not.toContain(otherOrgId);
  });

  it("scopes deleteEvent by org_id so cross-tenant deletes cannot target foreign rows", async () => {
    const recording = recordingSql([
      // selectEventForActor → empty (no access / wrong org)
      [],
    ]);
    const store = new PostgresCalendarStore(recording.sql);

    await expect(store.deleteEvent({ orgId: otherOrgId, actorId, eventId })).resolves.toBeNull();

    // Must not issue a destructive update when the event is invisible.
    expect(recording.calls.some((query) => query.includes("update cal_events"))).toBe(false);
    expect(recording.calls.some((query) => query.includes("delete from cal_events"))).toBe(false);
    // Lookup still binds the caller's org (otherOrgId here) — never omits org filter.
    expect(recording.values[0]).toEqual(expect.arrayContaining([eventId, otherOrgId]));
  });

  it("binds free-busy queries to the request orgId", async () => {
    const recording = recordingSql([[]]);
    const store = new PostgresCalendarStore(recording.sql);

    await expect(
      store.listCalendarFreeBusyEvents({
        orgId,
        actorIds: [actorId],
        startsAt: new Date("2026-05-20T00:00:00.000Z"),
        endsAt: new Date("2026-05-20T23:59:59.000Z"),
      }),
    ).resolves.toEqual([]);

    expect(recording.calls.join("\n")).toContain("org_id");
    expect(recording.values.some((values) => values.includes(orgId))).toBe(true);
  });
});

function recordingSql(responses: readonly unknown[][]): {
  readonly sql: postgres.Sql;
  readonly calls: string[];
  readonly values: unknown[][];
} {
  const calls: string[] = [];
  const values: unknown[][] = [];
  let responseIndex = 0;
  const tag = (async (strings: TemplateStringsArray, ...params: unknown[]) => {
    calls.push(strings.join("?"));
    values.push(params);
    return responses[responseIndex++] ?? [];
  }) as unknown as postgres.Sql;
  Object.assign(tag, {
    array: (items: readonly unknown[]) => items,
    json: (value: unknown) => value,
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) =>
      callback(tag as unknown as postgres.TransactionSql),
  });
  return { sql: tag, calls, values };
}
