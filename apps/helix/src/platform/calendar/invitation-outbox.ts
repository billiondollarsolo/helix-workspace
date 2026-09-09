import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { withTenantIoSagaPostgresContext } from "../tenancy/postgres-roles.js";
import { calendarDeliveryMessageId, type CalendarInvitationSender } from "./ics.js";
import type { CalendarAttendeeRecord, CalendarEventRecord } from "./types.js";

type SqlLike = postgres.Sql | postgres.TransactionSql;
type InvitationMethod = "REQUEST" | "CANCEL";

interface DeliveryPayload {
  readonly event: SerializedEvent;
  readonly rsvpBaseUrl?: string | undefined;
}

type SerializedEvent = Omit<
  CalendarEventRecord,
  "startsAt" | "endsAt" | "deletedAt" | "createdAt" | "updatedAt" | "attendees"
> & {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attendees: readonly SerializedAttendee[];
};

type SerializedAttendee = Omit<
  CalendarAttendeeRecord,
  "respondedAt" | "createdAt" | "updatedAt"
> & {
  readonly respondedAt?: string | null | undefined;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
};

export async function enqueueCalendarInvitationDeliveries(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly event: CalendarEventRecord;
    readonly method: InvitationMethod;
    readonly attendees?: readonly CalendarAttendeeRecord[] | undefined;
    readonly rsvpBaseUrl?: string | undefined;
  },
): Promise<number> {
  const recipients = (input.attendees ?? input.event.attendees).filter(
    (attendee) => attendee.isOrganizer !== true,
  );
  let queued = 0;
  for (const attendee of recipients) {
    const recipient = attendee.email.trim().toLowerCase();
    await sql`
      update calendar_invitation_deliveries
      set status = 'superseded', next_attempt_at = null, updated_at = now()
      where org_id = ${input.orgId} and event_id = ${input.event.id}
        and recipient = ${recipient} and event_revision < ${input.event.icsSequence}
        and status = 'queued'
    `;
    const event = invitationEventForRecipient(input.event, attendee, input.method);
    const payload: DeliveryPayload = {
      event: serializeEvent(event),
      ...(input.rsvpBaseUrl === undefined ? {} : { rsvpBaseUrl: input.rsvpBaseUrl }),
    };
    const rows = await sql<{ id: string }[]>`
      insert into calendar_invitation_deliveries (
        org_id, event_id, actor_id, event_revision, recipient, message_type,
        payload, next_attempt_at
      ) values (
        ${input.orgId}, ${input.event.id}, ${input.actorId}, ${input.event.icsSequence},
        ${recipient}, ${input.method}, ${sql.json(toSqlJson(payload))}, now()
      )
      on conflict (org_id, event_id, event_revision, recipient, message_type) do nothing
      returning id
    `;
    queued += rows.length;
  }
  return queued;
}

function toSqlJson(value: object): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

export interface ClaimedCalendarInvitationDelivery {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly eventId: string;
  readonly eventRevision: number;
  readonly recipient: string;
  readonly method: InvitationMethod;
  readonly attemptCount: number;
  readonly leaseToken: string;
  readonly event: CalendarEventRecord;
  readonly rsvpBaseUrl?: string | undefined;
}

interface DeliveryRow {
  readonly id: string;
  readonly org_id: string;
  readonly event_id: string;
  readonly actor_id: string;
  readonly event_revision: number;
  readonly recipient: string;
  readonly message_type: InvitationMethod;
  readonly attempt_count: number;
  readonly lease_token: string;
  readonly payload: DeliveryPayload;
}

export class PostgresCalendarInvitationDeliveryStore {
  constructor(private readonly sql: postgres.Sql) {}

  async withActorContext<T>(
    input: { readonly orgId: string; readonly actorId: string },
    callback: () => Promise<T>,
  ): Promise<T> {
    return withTenantIoSagaPostgresContext(this.sql, input, async () => callback());
  }

  async claim(input: {
    readonly owner: string;
    readonly limit: number;
    readonly leaseSeconds: number;
  }): Promise<readonly ClaimedCalendarInvitationDelivery[]> {
    const rows = await this.sql<DeliveryRow[]>`
      select * from helix_claim_calendar_invitation_deliveries(
        ${input.owner}, ${input.limit}, ${input.leaseSeconds}
      )
    `;
    return rows.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      actorId: row.actor_id,
      eventId: row.event_id,
      eventRevision: row.event_revision,
      recipient: row.recipient,
      method: row.message_type,
      attemptCount: row.attempt_count,
      leaseToken: row.lease_token,
      event: deserializeEvent(row.payload.event),
      ...(row.payload.rsvpBaseUrl === undefined ? {} : { rsvpBaseUrl: row.payload.rsvpBaseUrl }),
    }));
  }

  async complete(input: {
    readonly id: string;
    readonly leaseToken: string;
    readonly mailOutboundId: string;
  }): Promise<boolean> {
    const rows = await this.sql<{ completed: boolean }[]>`
      select helix_complete_calendar_invitation_delivery(
        ${input.id}, ${input.leaseToken}, ${input.mailOutboundId}
      ) completed
    `;
    return rows[0]?.completed === true;
  }

  async fail(input: {
    readonly id: string;
    readonly leaseToken: string;
    readonly error: string;
    readonly retryDelaySeconds: number;
    readonly maxAttempts: number;
  }): Promise<boolean> {
    const rows = await this.sql<{ failed: boolean }[]>`
      select helix_fail_calendar_invitation_delivery(
        ${input.id}, ${input.leaseToken}, ${input.error},
        ${input.retryDelaySeconds}, ${input.maxAttempts}
      ) failed
    `;
    return rows[0]?.failed === true;
  }

  async findMailOutbound(orgId: string, deliveryId: string): Promise<string | null> {
    const messageId = calendarDeliveryMessageId(deliveryId);
    const rows = await this.sql<{ id: string }[]>`
      select id from mail_outbound_messages
      where org_id = ${orgId} and envelope ->> 'messageId' = ${messageId}
      limit 1
    `;
    return rows[0]?.id ?? null;
  }

  async prepare(input: { readonly id: string; readonly leaseToken: string }): Promise<boolean> {
    const current = await this.sql<{ id: string }[]>`
      select delivery.id
      from calendar_invitation_deliveries delivery
      join cal_events event
        on event.org_id = delivery.org_id and event.id = delivery.event_id
      where delivery.id = ${input.id}
        and delivery.status = 'processing'
        and delivery.lease_token = ${input.leaseToken}
        and delivery.event_revision = event.ics_sequence
      for update of delivery
      for share of event
    `;
    if (current[0] !== undefined) return true;
    await this.sql`
      update calendar_invitation_deliveries
      set status = 'superseded', lease_owner = null, lease_token = null,
          lease_expires_at = null, updated_at = statement_timestamp()
      where id = ${input.id} and status = 'processing' and lease_token = ${input.leaseToken}
    `;
    return false;
  }
}

export interface CalendarInvitationDeliveryWorkerOptions {
  readonly store: Pick<
    PostgresCalendarInvitationDeliveryStore,
    "claim" | "complete" | "fail" | "findMailOutbound" | "prepare" | "withActorContext"
  >;
  readonly sender: CalendarInvitationSender;
  readonly owner?: string | undefined;
  readonly batchSize?: number | undefined;
  readonly leaseSeconds?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly intervalMs?: number | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
}

export class CalendarInvitationDeliveryWorker {
  private readonly owner: string;
  private readonly batchSize: number;
  private readonly leaseSeconds: number;
  private readonly maxAttempts: number;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<number> | undefined;

  constructor(private readonly options: CalendarInvitationDeliveryWorkerOptions) {
    this.owner = options.owner ?? `calendar-invitations-${randomUUID()}`;
    this.batchSize = options.batchSize ?? 25;
    this.leaseSeconds = options.leaseSeconds ?? 300;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.intervalMs = options.intervalMs ?? 1_000;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.runScheduled(), this.intervalMs);
    void this.runScheduled();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }

  async drainOnce(): Promise<number> {
    const deliveries = await this.options.store.claim({
      owner: this.owner,
      limit: this.batchSize,
      leaseSeconds: this.leaseSeconds,
    });
    for (const delivery of deliveries) await this.deliver(delivery);
    return deliveries.length;
  }

  private async deliver(delivery: ClaimedCalendarInvitationDelivery): Promise<void> {
    await this.options.store.withActorContext(delivery, async () => this.deliverInContext(delivery));
  }

  private async deliverInContext(delivery: ClaimedCalendarInvitationDelivery): Promise<void> {
    try {
      if (!(await this.options.store.prepare(delivery))) return;
      const existing = await this.options.store.findMailOutbound(delivery.orgId, delivery.id);
      const outboundId = existing ?? (await this.queue(delivery));
      await this.options.store.complete({
        id: delivery.id,
        leaseToken: delivery.leaseToken,
        mailOutboundId: outboundId,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.options.store.findMailOutbound(delivery.orgId, delivery.id);
        if (existing !== null) {
          await this.options.store.complete({
            id: delivery.id,
            leaseToken: delivery.leaseToken,
            mailOutboundId: existing,
          });
          return;
        }
      }
      await this.options.store.fail({
        id: delivery.id,
        leaseToken: delivery.leaseToken,
        error: error instanceof Error ? error.message : String(error),
        retryDelaySeconds: Math.min(3600, 2 ** delivery.attemptCount),
        maxAttempts: this.maxAttempts,
      });
      this.options.onError?.(error);
    }
  }

  private async queue(delivery: ClaimedCalendarInvitationDelivery): Promise<string> {
    const queued = await this.options.sender.sendInvitation({
      orgId: delivery.orgId,
      actorId: delivery.actorId,
      event: delivery.event,
      method: delivery.method,
      deliveryId: delivery.id,
      ...(delivery.rsvpBaseUrl === undefined ? {} : { rsvpBaseUrl: delivery.rsvpBaseUrl }),
    });
    const outboundId = queued[0]?.id;
    if (queued.length !== 1 || outboundId === undefined) {
      throw new Error("Calendar invitation delivery must queue exactly one outbound message.");
    }
    return outboundId;
  }

  private runScheduled(): Promise<number> {
    if (this.active !== undefined) return this.active;
    this.active = this.drainOnce()
      .catch((error: unknown) => {
        this.options.onError?.(error);
        return 0;
      })
      .finally(() => {
        this.active = undefined;
      });
    return this.active;
  }
}

function invitationEventForRecipient(
  event: CalendarEventRecord,
  attendee: CalendarAttendeeRecord,
  method: InvitationMethod,
): CalendarEventRecord {
  return {
    ...event,
    status: method === "CANCEL" ? "cancelled" : event.status,
    attendees: [
      ...event.attendees.filter((candidate) => candidate.isOrganizer === true),
      attendee,
    ],
  };
}

function serializeEvent(event: CalendarEventRecord): SerializedEvent {
  return {
    ...event,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
    deletedAt: event.deletedAt?.toISOString() ?? null,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
    attendees: event.attendees.map((attendee) => {
      const { respondedAt, createdAt, updatedAt, ...record } = attendee;
      return {
        ...record,
        ...(respondedAt === undefined
          ? {}
          : { respondedAt: respondedAt === null ? null : respondedAt.toISOString() }),
        ...(createdAt === undefined ? {} : { createdAt: createdAt.toISOString() }),
        ...(updatedAt === undefined ? {} : { updatedAt: updatedAt.toISOString() }),
      };
    }),
  };
}

function deserializeEvent(event: SerializedEvent): CalendarEventRecord {
  return {
    ...event,
    startsAt: new Date(event.startsAt),
    endsAt: new Date(event.endsAt),
    deletedAt: event.deletedAt === null ? null : new Date(event.deletedAt),
    createdAt: new Date(event.createdAt),
    updatedAt: new Date(event.updatedAt),
    attendees: event.attendees.map((attendee) => {
      const { respondedAt, createdAt, updatedAt, ...record } = attendee;
      return {
        ...record,
        ...(respondedAt === undefined
          ? {}
          : { respondedAt: respondedAt === null ? null : new Date(respondedAt) }),
        ...(createdAt === undefined ? {} : { createdAt: new Date(createdAt) }),
        ...(updatedAt === undefined ? {} : { updatedAt: new Date(updatedAt) }),
      };
    }),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
