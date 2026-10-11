import { isJsonObject, type JsonObject } from "@helix/sdk-types";
import type postgres from "postgres";
import type {
  InboundCalendarInvitationDelivery,
  InboundCalendarInvitationImporter,
  MailInboundRecipient,
} from "../mail/index.js";
import type { CalendarAttendeeInput, CalendarStore } from "./store.js";
import type { CalendarEventRecord, CalendarResponseStatus } from "./types.js";
import {
  componentText,
  parseIcsBody,
  parseVeventCalendar,
  type ICalComponent,
  type ParsedVevent,
} from "./vevent-parser.js";

/** Tenant feature flag (default off) that lets inbound iMIP invitations reach calendars. */
export const CALENDAR_IMPORT_INVITATIONS_FLAG = "calendar_import_invitations";

const MAX_INVITATION_ICS_BYTES = 1024 * 1024;
const MAX_INVITATION_VEVENTS = 1_000;
const CALENDAR_CONTENT_TYPES = new Set(["text/calendar", "application/ics"]);

interface InboundInvitationBase {
  readonly uid: string;
  readonly sequence: number;
  readonly organizerEmail: string;
  readonly organizerName: string | null;
}

export type InboundInvitation =
  | (InboundInvitationBase & { readonly method: "REQUEST"; readonly event: ParsedVevent })
  | (InboundInvitationBase & { readonly method: "CANCEL" });

export type InvitationImportOutcome = "created" | "updated" | "cancelled" | "skipped";

/**
 * Parse one iMIP calendar object. Only METHOD:REQUEST and METHOD:CANCEL with a
 * master VEVENT, a UID and a mailto ORGANIZER are accepted; anything else
 * (malformed, oversized, instance-only, other methods) yields null.
 */
export function parseInboundInvitation(body: string | Buffer): InboundInvitation | null {
  if (Buffer.byteLength(body) > MAX_INVITATION_ICS_BYTES) return null;
  const calendar = parseIcsBody(body);
  if (calendar === null) return null;
  const method = componentText(calendar, "method")?.toUpperCase();
  if (method !== "REQUEST" && method !== "CANCEL") return null;
  const vevents = calendar.getAllSubcomponents("vevent");
  if (vevents.length === 0 || vevents.length > MAX_INVITATION_VEVENTS) return null;
  const master = vevents.find((candidate) => !candidate.hasProperty("recurrence-id"));
  if (master === undefined) return null;
  const uid = componentText(master, "uid");
  const sequence = icsSequence(master);
  const organizer = mailtoAddress(master.getFirstProperty("organizer")?.getFirstValue());
  if (uid === null || sequence === null || organizer === null) return null;
  const organizerName = master.getFirstProperty("organizer")?.getFirstParameter("cn");
  const base = {
    uid,
    sequence,
    organizerEmail: organizer,
    organizerName: typeof organizerName === "string" && organizerName !== "" ? organizerName : null,
  };
  if (method === "CANCEL") return { ...base, method };
  const event = parseVeventCalendar(calendar);
  return event === null || event.uid !== uid ? null : { ...base, method, event };
}

/** Collect distinct invitations from a message's text/calendar and application/ics parts. */
export function extractInboundInvitations(
  attachments: InboundCalendarInvitationDelivery["attachments"],
): readonly InboundInvitation[] {
  const invitations = new Map<string, InboundInvitation>();
  for (const attachment of attachments) {
    if (!CALENDAR_CONTENT_TYPES.has(attachment.contentType.toLowerCase())) continue;
    let invitation: InboundInvitation | null;
    try {
      invitation = parseInboundInvitation(attachment.content);
    } catch {
      invitation = null;
    }
    const key = invitation === null ? null : `${invitation.method}:${invitation.uid}`;
    if (invitation !== null && key !== null && !invitations.has(key)) {
      invitations.set(key, invitation);
    }
  }
  return [...invitations.values()];
}

export interface CalendarInvitationImporterOptions {
  /** Tenant-aware client: `begin` becomes a savepoint inside the delivery's tenant transaction. */
  readonly sql: postgres.Sql;
  readonly store: Pick<
    CalendarStore,
    "createEvent" | "updateEvent" | "deleteEvent" | "getEventForActor"
  >;
  /** Resolve the tenant's `calendar_import_invitations` flag. */
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  readonly logger?: { warn(details: object, message: string): void } | undefined;
}

/**
 * Imports inbound iMIP REQUEST/CANCEL invitations into each delivered
 * recipient's own calendar. The external organizer is recorded in metadata and
 * on the attendee list; no outbound invitation mail is queued. Every failure is
 * logged and swallowed so mail delivery is never affected.
 */
export class CalendarInvitationImporter implements InboundCalendarInvitationImporter {
  constructor(private readonly options: CalendarInvitationImporterOptions) {}

  async importInvitations(delivery: InboundCalendarInvitationDelivery): Promise<void> {
    try {
      const invitations = extractInboundInvitations(delivery.attachments);
      if (invitations.length === 0 || delivery.recipients.length === 0) return;
      const enabled = await this.isolated(() => this.options.isEnabled(delivery.orgId));
      if (!enabled) return;
      for (const recipient of delivery.recipients) {
        for (const invitation of invitations) {
          await this.isolated(() =>
            this.importForRecipient(delivery.orgId, recipient, invitation, delivery.messageId),
          ).catch((error: unknown) => {
            this.warn(error, delivery, invitation);
          });
        }
      }
    } catch (error) {
      this.warn(error, delivery);
    }
  }

  /** Apply one invitation to one recipient's calendar. Exposed for focused tests. */
  async importForRecipient(
    orgId: string,
    recipient: Pick<MailInboundRecipient, "actorId" | "address">,
    invitation: InboundInvitation,
    messageId: string,
  ): Promise<InvitationImportOutcome> {
    const actorId = recipient.actorId;
    const existing = await this.findEventByUid(orgId, actorId, invitation.uid);
    if (existing === "hidden") return "skipped";
    const imported = existing !== null && isImportedFor(existing, actorId) ? existing : null;
    if (imported !== null && invitation.sequence < importedSequence(imported)) return "skipped";
    if (invitation.method === "CANCEL") {
      if (imported === null) return "skipped";
      const cancelled = await this.options.store.deleteEvent({
        orgId,
        actorId,
        eventId: imported.id,
      });
      return cancelled === null ? "skipped" : "cancelled";
    }
    // Same UID already visible but not imported for this actor: an internal
    // invitation (or another recipient's import) already placed it here.
    if (existing !== null && imported === null) return "skipped";
    if (!isAttendee(invitation.event, recipient.address)) return "skipped";
    const event = invitation.event;
    const metadata: JsonObject = {
      ...event.metadata,
      source: "mail.invitation",
      importedInvitation: {
        organizerEmail: invitation.organizerEmail,
        ...(invitation.organizerName === null ? {} : { organizerName: invitation.organizerName }),
        method: invitation.method,
        sequence: invitation.sequence,
        messageId,
      },
    };
    const fields = {
      title: event.title,
      description: event.description,
      location: event.location,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      timezone: event.timezone,
      allDay: event.allDay,
      timeSemantics: event.timeSemantics,
      recurrenceRule: event.recurrenceRule,
      attendees: withExternalOrganizer(event.attendees, invitation),
      metadata,
    };
    // `sendInvitations` stays unset: the organizer is external and owns delivery.
    const saved =
      imported === null
        ? await this.options.store.createEvent({ orgId, actorId, uid: event.uid, ...fields })
        : await this.options.store.updateEvent({
            orgId,
            actorId,
            eventId: imported.id,
            patch: fields,
          });
    if (saved === null) return "skipped";
    await this.markExternalOrganizer({
      orgId,
      actorId,
      eventId: saved.id,
      organizerEmail: invitation.organizerEmail,
      responseStatus: recipientResponse(imported, actorId),
    });
    return imported === null ? "created" : "updated";
  }

  private async findEventByUid(
    orgId: string,
    actorId: string,
    uid: string,
  ): Promise<CalendarEventRecord | "hidden" | null> {
    const rows = await this.options.sql<{ readonly id: string }[]>`
      select id from cal_events
      where org_id = ${orgId} and uid = ${uid} and deleted_at is null
      limit 1
    `;
    const id = rows[0]?.id;
    if (id === undefined) return null;
    const event = await this.options.store.getEventForActor({ orgId, actorId, eventId: id });
    return event ?? "hidden";
  }

  /**
   * The store records the calendar owner as organizer; an imported invitation
   * belongs to an external organizer, and the recipient has not answered yet.
   */
  private async markExternalOrganizer(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly eventId: string;
    readonly organizerEmail: string;
    readonly responseStatus: CalendarResponseStatus;
  }): Promise<void> {
    const { orgId, actorId, eventId, organizerEmail, responseStatus } = input;
    await this.options.sql`
      update cal_events set organizer_email = ${organizerEmail}
      where id = ${eventId} and org_id = ${orgId}
    `;
    await this.options.sql`
      update cal_attendees
      set is_organizer = lower(email) = ${organizerEmail},
          response_status = case
            when actor_id = ${actorId} and lower(email) <> ${organizerEmail}
              then ${responseStatus}
            else response_status
          end
      where event_id = ${eventId} and org_id = ${orgId}
    `;
  }

  private isolated<T>(operation: () => Promise<T>): Promise<T> {
    return this.options.sql.begin(() => operation()) as Promise<T>;
  }

  private warn(
    error: unknown,
    delivery: InboundCalendarInvitationDelivery,
    invitation?: InboundInvitation,
  ): void {
    this.options.logger?.warn(
      {
        err: error,
        orgId: delivery.orgId,
        messageId: delivery.messageId,
        ...(invitation === undefined ? {} : { uid: invitation.uid, method: invitation.method }),
      },
      "Calendar invitation import failed; mail delivery continues",
    );
  }
}

function icsSequence(component: ICalComponent): number | null {
  const raw = component.getFirstPropertyValue("sequence");
  const sequence = raw === null ? 0 : Number(raw);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

function mailtoAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const address = (
    trimmed.toLowerCase().startsWith("mailto:") ? trimmed.slice("mailto:".length) : trimmed
  )
    .trim()
    .toLowerCase();
  return /^[^\s@]+@[^\s@]+$/u.test(address) ? address : null;
}

function importedInvitationOf(event: CalendarEventRecord): JsonObject | null {
  const value = event.metadata.importedInvitation;
  return isJsonObject(value) ? value : null;
}

function isImportedFor(event: CalendarEventRecord, actorId: string): boolean {
  return event.organizerActorId === actorId && importedInvitationOf(event) !== null;
}

function importedSequence(event: CalendarEventRecord): number {
  const sequence = importedInvitationOf(event)?.sequence;
  return typeof sequence === "number" ? sequence : 0;
}

function isAttendee(event: ParsedVevent, address: string): boolean {
  const normalized = address.trim().toLowerCase();
  return event.attendees.some((attendee) => attendee.email.trim().toLowerCase() === normalized);
}

function withExternalOrganizer(
  attendees: readonly CalendarAttendeeInput[],
  invitation: InboundInvitationBase,
): readonly CalendarAttendeeInput[] {
  const others = attendees.filter(
    (attendee) => attendee.email.trim().toLowerCase() !== invitation.organizerEmail,
  );
  return [
    ...others,
    {
      email: invitation.organizerEmail,
      displayName: invitation.organizerName,
      role: "required",
      responseStatus: "accepted",
    },
  ];
}

/** Keep an answer the recipient already gave; a first import awaits their RSVP. */
function recipientResponse(
  imported: CalendarEventRecord | null,
  actorId: string,
): CalendarResponseStatus {
  const current = imported?.attendees.find(
    (attendee) => attendee.actorId === actorId && attendee.isOrganizer !== true,
  );
  return current?.responseStatus ?? "needs_action";
}
