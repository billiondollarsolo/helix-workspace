import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { PostgresCalendarStore } from "./store.js";

const ORG = "ca700000-0000-4000-8000-000000000001";
const OWNER = "ca700000-0000-4000-8000-000000000011";
const KEPT = "ca700000-0000-4000-8000-000000000012";
const REMOVED = "ca700000-0000-4000-8000-000000000013";

describe(
  "Calendar attendee identity diff",
  { skip: process.env.DATABASE_URL === undefined },
  () => {
    let sql: postgres.Sql;
    let store: PostgresCalendarStore;

    beforeAll(async () => {
      if (process.env.DATABASE_URL === undefined) throw new Error("DATABASE_URL is required.");
      sql = postgres(process.env.DATABASE_URL, { max: 2, prepare: false });
      store = new PostgresCalendarStore(sql);
      await cleanup(sql);
      await sql`
      insert into orgs (id, slug, display_name)
      values (${ORG}, 'calendar-attendee-diff', 'Calendar attendee diff')
    `;
      await sql`
      insert into actors (id, org_id, type, email, display_name)
      values
        (${OWNER}, ${ORG}, 'user', 'owner@calendar.test', 'Owner'),
        (${KEPT}, ${ORG}, 'user', 'kept@calendar.test', 'Kept'),
        (${REMOVED}, ${ORG}, 'user', 'removed@calendar.test', 'Removed')
    `;
    });

    afterAll(async () => {
      await cleanup(sql);
      await sql.end();
    });

    it("preserves unchanged RSVP evidence and revokes only removed attendees", async () => {
      const event = await store.createEvent({
        orgId: ORG,
        actorId: OWNER,
        title: "Stable RSVP",
        startsAt: new Date("2026-10-01T14:00:00.000Z"),
        endsAt: new Date("2026-10-01T15:00:00.000Z"),
        attendees: [
          { actorId: KEPT, email: "kept@calendar.test" },
          { actorId: REMOVED, email: "removed@calendar.test" },
          { email: "external@example.test" },
        ],
      });
      const respondedAt = new Date("2026-09-20T12:00:00.000Z");
      await sql`
      update cal_attendees
      set response_status = 'tentative', responded_at = ${respondedAt},
          metadata = '{"responseEvidence":"kept"}'::jsonb
      where event_id = ${event.id} and actor_id = ${KEPT}
    `;
      const original = await attendeeEvidence(sql, event.id);

      const renamed = await store.updateEvent({
        orgId: ORG,
        actorId: OWNER,
        eventId: event.id,
        patch: { title: "Stable RSVP renamed" },
      });
      expect(await attendeeEvidence(sql, event.id)).toEqual(original);

      const updated = await store.updateEvent({
        orgId: ORG,
        actorId: OWNER,
        eventId: event.id,
        patch: {
          attendees: [{ actorId: KEPT, email: "kept@calendar.test", role: "optional" }],
        },
      });
      const keptBefore = original.find(({ actor_id }) => actor_id === KEPT);
      const keptAfter = (await attendeeEvidence(sql, event.id)).find(
        ({ actor_id }) => actor_id === KEPT,
      );
      expect(keptAfter).toMatchObject({
        id: keptBefore?.id,
        rsvp_token: keptBefore?.rsvp_token,
        response_status: "tentative",
        responded_at: respondedAt,
        role: "optional",
        metadata: { responseEvidence: "kept" },
      });
      expect(renamed?.icsSequence).toBe(event.icsSequence + 1);
      expect(updated?.icsSequence).toBe(event.icsSequence + 2);

      const removedTokens = original
        .filter(
          ({ actor_id, is_organizer }) =>
            actor_id === REMOVED || (!is_organizer && actor_id === null),
        )
        .map(({ rsvp_token }) => rsvp_token);
      await expect(
        Promise.all(
          removedTokens.map((rsvpToken) =>
            store.respondToRsvpToken({ rsvpToken, responseStatus: "accepted" }),
          ),
        ),
      ).resolves.toEqual(removedTokens.map(() => null));
      const grants = await sql<{ count: number }[]>`
      select count(*)::int as count from permissions
      where org_id = ${ORG} and actor_id = ${REMOVED}
        and resource_type = 'event' and resource_id = ${event.id} and role = 'participant'
    `;
      expect(grants[0]?.count).toBe(0);
    });
  },
);

interface AttendeeEvidence {
  readonly id: string;
  readonly actor_id: string | null;
  readonly role: string;
  readonly response_status: string;
  readonly rsvp_token: string;
  readonly responded_at: Date | null;
  readonly is_organizer: boolean;
  readonly metadata: Record<string, unknown>;
}

async function attendeeEvidence(sql: postgres.Sql, eventId: string): Promise<AttendeeEvidence[]> {
  return sql<AttendeeEvidence[]>`
    select id, actor_id, role, response_status, rsvp_token, responded_at, is_organizer, metadata
    from cal_attendees where org_id = ${ORG} and event_id = ${eventId}
    order by actor_id nulls last, email
  `;
}

async function cleanup(sql: postgres.Sql): Promise<void> {
  await sql`delete from outbox where payload->>'orgId' = ${ORG}`;
  await cleanupTestTenants(sql, [ORG]);
}
