import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CalendarInvitationDeliveryWorker,
  PostgresCalendarInvitationDeliveryStore,
} from "../../platform/calendar/invitation-outbox.js";
import { createMailCalendarInvitationSender } from "../../platform/calendar/ics.js";
import { PostgresCalendarStore } from "../../platform/calendar/store.js";
import { PostgresMailStore } from "../../platform/mail/store.js";
import { tenantAwarePostgresSql } from "../../platform/tenancy/postgres-roles.js";

const DATABASE_URL = process.env.DATABASE_URL;
const sql = DATABASE_URL === undefined ? null : postgres(DATABASE_URL, { max: 4, prepare: false });

describe("0129 calendar invitation outbox migration", () => {
  it("defines revision/recipient/type idempotency on a leased audited queue", async () => {
    const migration = await readFile(
      new URL("./0129_calendar_invitation_outbox.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("unique (org_id, event_id, event_revision, recipient, message_type)");
    expect(migration).toContain("for update skip locked");
    expect(migration).toContain("dead_lettered");
    expect(migration).toContain("calendar_invitation_delivery_events");
    expect(migration).toContain("mail_outbound_calendar_message_id_uidx");
    expect(migration).toContain(
      "create policy helix_tenant_isolation on calendar_invitation_deliveries",
    );
    expect(migration).toContain(
      "create policy helix_tenant_isolation on calendar_invitation_delivery_events",
    );
  });
});

describe.skipIf(sql === null)("0129 live calendar invitation outbox", () => {
  const database = sql as postgres.Sql;
  const store = new PostgresCalendarStore(database);
  const deliveryStore = new PostgresCalendarInvitationDeliveryStore(database);
  const tenantSql = tenantAwarePostgresSql(database);
  const orgA = "c0800000-0000-4000-8000-000000000001";
  const orgB = "c0800000-0000-4000-8000-000000000002";
  const ownerA = "c0800000-0000-4000-8000-000000000011";
  const ownerB = "c0800000-0000-4000-8000-000000000012";
  const invalidEvent = "c0800000-0000-4000-8000-000000000099";

  beforeAll(async () => {
    await cleanup();
    await database`
      insert into orgs (id, slug, display_name) values
        (${orgA}, 'col08-a', 'COL 08 A'), (${orgB}, 'col08-b', 'COL 08 B')
    `;
    await database`
      insert into admin_domains (
        org_id, domain, is_primary, status, verified_at, verification_host,
        verification_value, verification_expires_at, identity_enabled, identity_mode
      ) values
        (${orgA}, 'col08-a.test', true, 'verified', now(), '_verify.col08-a.test',
          'col08-a', now() + interval '1 day', true, 'secondary'),
        (${orgB}, 'col08-b.test', true, 'verified', now(), '_verify.col08-b.test',
          'col08-b', now() + interval '1 day', true, 'secondary')
    `;
    await database`
      insert into actors (id, org_id, type, email, display_name) values
        (${ownerA}, ${orgA}, 'user', 'owner@col08-a.test', 'Owner A'),
        (${ownerB}, ${orgB}, 'user', 'owner@col08-b.test', 'Owner B')
    `;
  });

  afterAll(async () => {
    await cleanup();
    await database.end();
  });

  it("commits event and invitations atomically and emits updates and removed-attendee cancellation", async () => {
    await expect(
      store.createEvent({
        id: invalidEvent,
        orgId: orgA,
        actorId: ownerA,
        title: "Must roll back",
        startsAt: new Date("2026-10-01T12:00:00Z"),
        endsAt: new Date("2026-10-01T13:00:00Z"),
        attendees: [{ email: "x" }],
        sendInvitations: true,
      }),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await database`select id from cal_events where id = ${invalidEvent}`).toEqual([]);

    const created = await store.createEvent({
      orgId: orgA,
      actorId: ownerA,
      title: "Durable invitation",
      startsAt: new Date("2026-10-01T12:00:00Z"),
      endsAt: new Date("2026-10-01T13:00:00Z"),
      attendees: [{ email: "kept@example.test" }, { email: "removed@example.test" }],
      sendInvitations: true,
      rsvpBaseUrl: "https://calendar.example.test",
    });
    expect(created.invitationDeliveriesQueued).toBe(2);

    const updated = await store.updateEvent({
      orgId: orgA,
      actorId: ownerA,
      eventId: created.id,
      sendInvitations: true,
      patch: {
        title: "Durable invitation updated",
        attendees: [{ email: "kept@example.test" }],
      },
    });
    expect(updated?.invitationDeliveriesQueued).toBe(2);

    const rows = await database<{
      event_revision: number;
      recipient: string;
      message_type: string;
      status: string;
    }[]>`
      select event_revision, recipient, message_type, status
      from calendar_invitation_deliveries where event_id = ${created.id}
      order by event_revision, recipient, message_type
    `;
    expect(rows).toEqual([
      { event_revision: 0, recipient: "kept@example.test", message_type: "REQUEST", status: "superseded" },
      { event_revision: 0, recipient: "removed@example.test", message_type: "REQUEST", status: "superseded" },
      { event_revision: 1, recipient: "kept@example.test", message_type: "REQUEST", status: "queued" },
      { event_revision: 1, recipient: "removed@example.test", message_type: "CANCEL", status: "queued" },
    ]);

    const deleted = await store.deleteEvent({
      orgId: orgA,
      actorId: ownerA,
      eventId: created.id,
      sendInvitations: true,
    });
    expect(deleted?.invitationDeliveriesQueued).toBe(1);
    const active = await database<{ recipient: string; message_type: string; event_revision: number }[]>`
      select recipient, message_type, event_revision from calendar_invitation_deliveries
      where event_id = ${created.id} and status = 'queued'
      order by recipient
    `;
    expect(active).toEqual([
      { recipient: "kept@example.test", message_type: "CANCEL", event_revision: 2 },
      { recipient: "removed@example.test", message_type: "CANCEL", event_revision: 1 },
    ]);
  });

  it("recovers expired leases, retries to DLQ, audits transitions, and isolates tenants", async () => {
    const staleClaimed = await database<DeliveryRow[]>`
      select * from helix_claim_calendar_invitation_deliveries('col08-test', 1, 300)
    `;
    expect(staleClaimed[0]?.event_revision).toBe(1);
    await expect(
      deliveryStore.prepare({
        id: staleClaimed[0]?.id ?? "",
        leaseToken: staleClaimed[0]?.lease_token ?? "",
      }),
    ).resolves.toBe(false);

    const claimed = await database<DeliveryRow[]>`
      select * from helix_claim_calendar_invitation_deliveries('col08-test', 1, 300)
    `;
    const delivery = claimed[0];
    expect(delivery?.event_revision).toBe(2);
    expect(delivery?.attempt_count).toBe(1);
    await database`
      update calendar_invitation_deliveries set lease_expires_at = now() - interval '1 second'
      where id = ${delivery?.id ?? ""}
    `;
    const reclaimed = await database<DeliveryRow[]>`
      select * from helix_claim_calendar_invitation_deliveries('col08-recovery', 1, 300)
    `;
    expect(reclaimed[0]).toMatchObject({ id: delivery?.id, attempt_count: 2 });
    await database`
      update calendar_invitation_deliveries
      set status = 'superseded', next_attempt_at = null
      where status = 'queued' and id <> ${delivery?.id ?? ""}
    `;

    let current = reclaimed[0];
    while (current !== undefined && current.attempt_count < 5) {
      await database`
        select helix_fail_calendar_invitation_delivery(
          ${current.id}, ${current.lease_token}, 'transient SMTP handoff', 0, 5
        )
      `;
      const next = await database<DeliveryRow[]>`
        select * from helix_claim_calendar_invitation_deliveries('col08-retry', 1, 300)
      `;
      current = next.find((row) => row.id === delivery?.id);
    }
    if (current !== undefined) {
      await database`
        select helix_fail_calendar_invitation_delivery(
          ${current.id}, ${current.lease_token}, 'permanent SMTP handoff', 0, 5
        )
      `;
    }
    const terminal = await database<{ status: string; dead_lettered_at: Date | null }[]>`
      select status, dead_lettered_at from calendar_invitation_deliveries where id = ${delivery?.id ?? ""}
    `;
    expect(terminal[0]).toMatchObject({ status: "dead_lettered" });
    expect(terminal[0]?.dead_lettered_at).toBeInstanceOf(Date);

    const audit = await database<{ count: number }[]>`
      select count(*)::integer count from calendar_invitation_delivery_events
      where delivery_id = ${delivery?.id ?? ""}
    `;
    const outbox = await database<{ count: number }[]>`
      select count(*)::integer count from outbox
      where payload ->> 'deliveryId' = ${delivery?.id ?? ""}
    `;
    expect(audit[0]?.count).toBeGreaterThanOrEqual(7);
    expect(outbox[0]?.count).toBe(audit[0]?.count);

    const visibleToOtherTenant = await database.begin(async (tx) => {
      await tx.unsafe("set local role helix_app");
      await tx`select set_config('helix.org_id', ${orgB}, true)`;
      return tx`select id from calendar_invitation_deliveries where org_id = ${orgA}`;
    });
    expect(visibleToOtherTenant).toEqual([]);
  });

  it("hands off once to the real mail outbox and rejects a duplicate delivery message ID", async () => {
    const attachmentObjectId = "c0800000-0000-4000-8000-000000000031";
    await database`
      insert into objects (
        id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, metadata
      ) values (
        ${attachmentObjectId}, ${orgA}, ${ownerA}, 'file', 'col08/invite.ics',
        'text/calendar', 1024, '{"status":"ready"}'::jsonb
      )
    `;
    const event = await new PostgresCalendarStore(tenantSql).createEvent({
      orgId: orgA,
      actorId: ownerA,
      title: "Exactly once handoff",
      startsAt: new Date("2026-10-02T12:00:00Z"),
      endsAt: new Date("2026-10-02T13:00:00Z"),
      attendees: [{ email: "one@example.test" }],
      sendInvitations: true,
    });
    const tenantDeliveryStore = new PostgresCalendarInvitationDeliveryStore(tenantSql);
    const sender = createMailCalendarInvitationSender({
      store: new PostgresMailStore(tenantSql, {
        attachmentIngestor: {
          async stage(input) {
            const { content: _content, ...attachment } = input.attachment;
            return {
              stageId: "c0800000-0000-4000-8000-000000000032",
              objectId: attachmentObjectId,
              orgId: input.orgId,
              ...(input.ownerActorId === undefined
                ? {}
                : { ownerActorId: input.ownerActorId }),
              storageKey: "col08/invite.ics",
              attachment: { ...attachment, objectId: attachmentObjectId },
            };
          },
          async release() {},
        },
      }),
      defaultFromDomain: "col08-a.test",
    });
    await expect(
      new CalendarInvitationDeliveryWorker({
        store: tenantDeliveryStore,
        sender,
        onError: (error) => {
          throw error;
        },
      }).drainOnce(),
    ).resolves.toBe(1);

    const delivery = await database<{ id: string; mail_outbound_id: string; status: string }[]>`
      select id, mail_outbound_id, status from calendar_invitation_deliveries
      where event_id = ${event.id}
    `;
    expect(delivery[0]?.status).toBe("handed_off");
    const deliveryId = delivery[0]?.id ?? "";
    await expect(
      sender.sendInvitation({
        orgId: orgA,
        actorId: ownerA,
        event,
        method: "REQUEST",
        deliveryId,
      }),
    ).rejects.toMatchObject({ code: "23505" });
    const outbound = await database<{ count: number }[]>`
      select count(*)::integer count from mail_outbound_messages
      where org_id = ${orgA}
        and envelope ->> 'messageId' = ${`<calendar-delivery-${deliveryId}@helix.local>`}
    `;
    expect(outbound[0]?.count).toBe(1);
  });

  interface DeliveryRow {
    readonly id: string;
    readonly event_revision: number;
    readonly attempt_count: number;
    readonly lease_token: string;
  }

  async function cleanup() {
    await database`delete from cal_events where org_id in (${orgA}, ${orgB})`;
    await database`delete from mail_outbound_messages where org_id in (${orgA}, ${orgB})`;
    await database`delete from messages where org_id in (${orgA}, ${orgB})`;
    await database`delete from objects where org_id in (${orgA}, ${orgB})`;
    await database`delete from outbox where payload->>'orgId' in (${orgA}, ${orgB})`;
    await database`delete from activity where org_id in (${orgA}, ${orgB})`;
    await database`delete from permissions where org_id in (${orgA}, ${orgB})`;
    await database`delete from cal_calendar_memberships where org_id in (${orgA}, ${orgB})`;
    await database`delete from cal_calendars where org_id in (${orgA}, ${orgB})`;
    await database`delete from threads where org_id in (${orgA}, ${orgB})`;
    await database`delete from organization_memberships where org_id in (${orgA}, ${orgB})`;
    await database`delete from actors where org_id in (${orgA}, ${orgB})`;
    await database`delete from admin_domains where org_id in (${orgA}, ${orgB})`;
    await database`delete from orgs where id in (${orgA}, ${orgB})`;
  }
});
