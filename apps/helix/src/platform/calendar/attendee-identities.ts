import type postgres from "postgres";
import type { CalendarAttendeeInput } from "./store.js";

/**
 * Matches attendees to the organization's active people: by actor id when
 * given (the address must be theirs), otherwise by address. Unknown addresses
 * stay external; disabled people are refused.
 */
interface CalendarIdentityRow {
  readonly id: string;
  readonly email: string | null;
  readonly display_name: string;
  readonly disabled_at: Date | null;
}

export async function resolveCalendarAttendees(
  sql: postgres.Sql | postgres.TransactionSql,
  orgId: string,
  attendees: readonly CalendarAttendeeInput[],
): Promise<readonly CalendarAttendeeInput[]> {
  if (attendees.length === 0) {
    return [];
  }
  const actorIds = [...new Set(attendees.flatMap((attendee) => attendee.actorId ?? []))];
  const emails = [...new Set(attendees.map((attendee) => attendee.email.trim().toLowerCase()))];
  const rows = await sql<CalendarIdentityRow[]>`
    select actor.id, actor.email, actor.display_name, actor.disabled_at
    from actors actor
    join orgs org on org.id = actor.org_id and org.status = 'active'
    where actor.org_id = ${orgId}
      and (
        actor.id = any(${sql.array(actorIds)}::uuid[])
        or lower(actor.email) = any(${sql.array(emails)}::text[])
      )
  `;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const byEmail = new Map(
    rows.flatMap((row) => (row.email === null ? [] : [[row.email.toLowerCase(), row] as const])),
  );
  return attendees.map((attendee) => {
    const email = attendee.email.trim().toLowerCase();
    const identity = attendee.actorId == null ? byEmail.get(email) : byId.get(attendee.actorId);
    if (identity !== undefined && identity.disabled_at !== null) {
      throw new Error(`Calendar attendee is disabled: ${email}`);
    }
    if (attendee.actorId != null && identity === undefined) {
      throw new Error(
        `Calendar attendee actor is not active in this organization: ${attendee.actorId}`,
      );
    }
    if (
      attendee.actorId != null &&
      (identity?.email === null || identity?.email.toLowerCase() !== email)
    ) {
      throw new Error(`Calendar attendee email does not match actor: ${attendee.actorId}`);
    }
    if (identity === undefined) {
      return { ...attendee, actorId: null, email };
    }
    if (identity.email === null) {
      throw new Error(`Calendar attendee actor has no verified address: ${identity.id}`);
    }
    return {
      ...attendee,
      actorId: identity.id,
      email: identity.email.toLowerCase(),
      displayName: identity.display_name,
    };
  });
}
