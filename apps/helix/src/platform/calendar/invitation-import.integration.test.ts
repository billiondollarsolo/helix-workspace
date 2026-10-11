import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { TenantConfigFeatureFlagProvider } from "../feature-flags/provider.js";
import { ingestRawMail, type MailMessageInput, type MailStore } from "../mail/index.js";
import { PostgresOrgStore } from "../tenancy/orgs.js";
import { loadEffectiveTenantConfig } from "../tenancy/effective-config.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import {
  CALENDAR_IMPORT_INVITATIONS_FLAG,
  CalendarInvitationImporter,
} from "./invitation-import.js";
import { PostgresCalendarStore } from "./store.js";

describe.skipIf(skipUnlessLiveDatabase("calendar invitation import"))(
  "inbound iMIP invitation import",
  () => {
    const admin = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? "", { max: 1 });
    const sql = tenantAwarePostgresSql(
      postgres(process.env.HELIX_RLS_APP_DATABASE_URL ?? "", { max: 3 }),
    );
    const calendar = new PostgresCalendarStore(sql);
    const flags = new TenantConfigFeatureFlagProvider({
      loadTenantConfig: ({ orgId }) =>
        loadEffectiveTenantConfig({ orgs: new PostgresOrgStore(sql) }, orgId),
    });
    const warn = vi.fn();
    const importer = new CalendarInvitationImporter({
      sql,
      store: calendar,
      isEnabled: (id) => flags.getAsync(CALENDAR_IMPORT_INVITATIONS_FLAG, false, { orgId: id }),
      logger: { warn },
    });
    const orgId = randomUUID(),
      rita = randomUUID(),
      owen = randomUUID();
    const ritaEmail = `rita@${orgId}.test`,
      owenEmail = `owen@${orgId}.test`;
    const organizer = "olga@external.example";
    const createOutbound = vi.fn();
    const delivered: MailMessageInput[] = [];
    const mailStore = {
      insertInboundMessage: async (message: MailMessageInput) => {
        delivered.push(message);
        return {
          created: true,
          deliveredActorIds: message.mailboxActorIds ?? [],
          threadId: randomUUID(),
          messageId: randomUUID(),
          attachmentObjectIds: [],
        };
      },
      listFilters: async () => [],
      getActiveVacation: async () => null,
      updateThreadState: async () => {},
      createOutbound,
    } as unknown as MailStore;

    beforeAll(async () => {
      await admin`insert into orgs (id, slug, display_name, status) values (${orgId}, ${orgId}, 'iMIP import', 'active')`;
      await admin`
        insert into actors (id, org_id, type, email, display_name)
        values (${rita}, ${orgId}, 'user', ${ritaEmail}, 'Rita'),
               (${owen}, ${orgId}, 'user', ${owenEmail}, 'Owen')
      `;
    });
    afterAll(async () => {
      await cleanupTestTenants(admin, [orgId]);
      await Promise.all([admin.end(), sql.end()]);
    });

    async function setFlag(enabled: boolean): Promise<void> {
      await admin`
        update orgs
        set feature_flags = feature_flags || ${admin.json({ [CALENDAR_IMPORT_INVITATIONS_FLAG]: enabled })}
        where id = ${orgId}
      `;
    }

    function invitation(input: {
      readonly uid: string;
      readonly method?: "REQUEST" | "CANCEL";
      readonly sequence?: number;
      readonly title?: string;
      readonly calendarBody?: string;
    }): string {
      const body =
        input.calendarBody ??
        [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "PRODID:-//External//EN",
          `METHOD:${input.method ?? "REQUEST"}`,
          "BEGIN:VEVENT",
          `UID:${input.uid}`,
          `SEQUENCE:${String(input.sequence ?? 0)}`,
          "DTSTAMP:20261001T120000Z",
          "DTSTART:20261020T150000Z",
          "DTEND:20261020T160000Z",
          `SUMMARY:${input.title ?? "Partner sync"}`,
          `ORGANIZER;CN=Olga:mailto:${organizer}`,
          `ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=Rita:mailto:${ritaEmail}`,
          "ATTENDEE;PARTSTAT=ACCEPTED:mailto:peer@external.example",
          ...(input.method === "CANCEL" ? ["STATUS:CANCELLED"] : []),
          "END:VEVENT",
          "END:VCALENDAR",
        ].join("\r\n");
      return [
        `From: Olga <${organizer}>`,
        `To: ${ritaEmail}`,
        `Subject: Invitation: ${input.title ?? "Partner sync"}`,
        `Message-ID: <${randomUUID()}@external.example>`,
        "MIME-Version: 1.0",
        'Content-Type: multipart/alternative; boundary="imip"',
        "",
        "--imip",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "You are invited.",
        "--imip",
        `Content-Type: text/calendar; charset=utf-8; method=${input.method ?? "REQUEST"}`,
        "",
        body,
        "--imip--",
        "",
      ].join("\r\n");
    }

    async function deliver(raw: string) {
      return withTenantPostgresContext(sql, { orgId }, () =>
        ingestRawMail({
          store: mailStore,
          input: {
            orgId,
            recipients: [{ orgId, actorId: rita, address: ritaEmail }],
            raw,
          },
          authenticator: {
            authenticate: async () => ({ spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" }),
          },
          calendarInvitations: importer,
        }),
      );
    }

    async function eventRows(uid: string) {
      return admin<
        {
          id: string;
          title: string;
          status: string;
          deleted_at: Date | null;
          organizer_email: string | null;
          owner_actor_id: string;
          metadata: Record<string, unknown>;
        }[]
      >`
        select e.id, e.title, e.status, e.deleted_at, e.organizer_email, c.owner_actor_id, e.metadata
        from cal_events e join cal_calendars c on c.id = e.calendar_id
        where e.org_id = ${orgId} and e.uid = ${uid}
        order by e.created_at
      `;
    }

    async function attendees(eventId: string) {
      return admin<
        { email: string; actor_id: string | null; response_status: string; is_organizer: boolean }[]
      >`
        select email, actor_id, response_status, is_organizer from cal_attendees
        where org_id = ${orgId} and event_id = ${eventId} order by email
      `;
    }

    async function invitationDeliveries(): Promise<number> {
      const rows = await admin<{ count: number }[]>`
        select count(*)::int as count from calendar_invitation_deliveries where org_id = ${orgId}
      `;
      return rows[0]?.count ?? 0;
    }

    it("does not import when the tenant flag is off (the default)", async () => {
      const uid = `${randomUUID()}@external.example`;
      const result = await deliver(invitation({ uid }));
      expect(result.stored.deliveredActorIds).toEqual([rita]);
      expect(await eventRows(uid)).toEqual([]);
      await setFlag(false);
      await deliver(invitation({ uid }));
      expect(await eventRows(uid)).toEqual([]);
    });

    it("imports, updates by SEQUENCE and cancels an external invitation without sending mail", async () => {
      await setFlag(true);
      const uid = `${randomUUID()}@external.example`;
      const first = await deliver(invitation({ uid }));

      const [created] = await eventRows(uid);
      expect(created).toMatchObject({
        title: "Partner sync",
        status: "confirmed",
        deleted_at: null,
        organizer_email: organizer,
        owner_actor_id: rita,
        metadata: {
          source: "mail.invitation",
          importedInvitation: {
            organizerEmail: organizer,
            organizerName: "Olga",
            method: "REQUEST",
            sequence: 0,
            messageId: first.stored.messageId,
          },
        },
      });
      if (created === undefined) throw new Error("Expected the imported event.");
      expect(await attendees(created.id)).toEqual([
        { email: organizer, actor_id: null, response_status: "accepted", is_organizer: true },
        {
          email: "peer@external.example",
          actor_id: null,
          response_status: "accepted",
          is_organizer: false,
        },
        { email: ritaEmail, actor_id: rita, response_status: "needs_action", is_organizer: false },
      ]);
      // The recipient sees it through the normal store read path.
      await expect(
        withTenantPostgresContext(sql, { orgId, actorId: rita }, () =>
          calendar.getEventForActor({ orgId, actorId: rita, eventId: created.id }),
        ),
      ).resolves.toMatchObject({ uid, title: "Partner sync" });

      // Rita answers, then the organizer sends a newer revision.
      await withTenantPostgresContext(sql, { orgId, actorId: rita }, () =>
        calendar.respondToEvent({
          orgId,
          actorId: rita,
          eventId: created.id,
          responseStatus: "accepted",
        }),
      );
      await deliver(invitation({ uid, sequence: 2, title: "Partner sync (moved)" }));
      const [updated] = await eventRows(uid);
      expect(updated).toMatchObject({
        id: created.id,
        title: "Partner sync (moved)",
        metadata: { importedInvitation: { sequence: 2 } },
      });
      expect(
        (await attendees(created.id)).find((attendee) => attendee.actor_id === rita),
      ).toMatchObject({ response_status: "accepted", is_organizer: false });

      // A stale revision is ignored.
      await deliver(invitation({ uid, sequence: 1, title: "Stale title" }));
      expect((await eventRows(uid))[0]).toMatchObject({
        title: "Partner sync (moved)",
        metadata: { importedInvitation: { sequence: 2 } },
      });

      await deliver(invitation({ uid, method: "CANCEL", sequence: 3 }));
      const [cancelled] = await eventRows(uid);
      expect(cancelled?.status).toBe("cancelled");
      expect(cancelled?.deleted_at).not.toBeNull();
      expect(await eventRows(uid)).toHaveLength(1);

      expect(await invitationDeliveries()).toBe(0);
      expect(createOutbound).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it("does not duplicate an event the recipient already has from an internal invitation", async () => {
      await setFlag(true);
      const uid = `${randomUUID()}@helix.local`;
      const internal = await withTenantPostgresContext(sql, { orgId, actorId: owen }, () =>
        calendar.createEvent({
          orgId,
          actorId: owen,
          uid,
          title: "Internal planning",
          startsAt: new Date("2026-10-20T15:00:00.000Z"),
          endsAt: new Date("2026-10-20T16:00:00.000Z"),
          attendees: [{ email: ritaEmail }],
        }),
      );
      await deliver(invitation({ uid, sequence: 5, title: "Overwritten?" }));
      const rows = await eventRows(uid);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: internal.id, title: "Internal planning" });
      expect(rows[0]?.metadata).not.toHaveProperty("importedInvitation");
    });

    it("still delivers mail when the calendar part is malformed or the import fails", async () => {
      await setFlag(true);
      const before = delivered.length;
      const malformed = await deliver(
        invitation({ uid: "unused", calendarBody: "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBROKEN" }),
      );
      expect(malformed.stored.deliveredActorIds).toEqual([rita]);

      // An attendee that cannot be resolved makes the store throw inside the import.
      await admin`update actors set disabled_at = now() where id = ${owen}`;
      const uid = `${randomUUID()}@external.example`;
      const failing = await deliver(
        invitation({ uid }).replace(
          "ATTENDEE;PARTSTAT=ACCEPTED:mailto:peer@external.example",
          `ATTENDEE:mailto:${owenEmail}`,
        ),
      );
      await admin`update actors set disabled_at = null where id = ${owen}`;
      expect(failing.stored.deliveredActorIds).toEqual([rita]);
      expect(delivered.length).toBe(before + 2);
      expect(await eventRows(uid)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ orgId, uid, method: "REQUEST" }),
        expect.stringContaining("mail delivery continues"),
      );
    });
  },
);
