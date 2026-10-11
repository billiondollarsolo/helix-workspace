import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import {
  CalendarInvitationImporter,
  extractInboundInvitations,
  parseInboundInvitation,
} from "./invitation-import.js";
import type { CalendarStore } from "./store.js";

function ics(input: {
  readonly method?: string;
  readonly sequence?: number;
  readonly extra?: readonly string[];
  readonly vevents?: number;
}): string {
  const vevent = [
    "BEGIN:VEVENT",
    "UID:launch@external.example",
    `SEQUENCE:${String(input.sequence ?? 0)}`,
    "DTSTAMP:20261001T120000Z",
    "DTSTART:20261020T150000Z",
    "DTEND:20261020T160000Z",
    "SUMMARY:Launch review",
    "ORGANIZER;CN=Olga Organizer:mailto:Olga@External.example",
    "ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=Rita:mailto:rita@helix.test",
    ...(input.extra ?? []),
    "END:VEVENT",
  ];
  const overrides = Array.from({ length: (input.vevents ?? 1) - 1 }, (_, index) => [
    "BEGIN:VEVENT",
    "UID:launch@external.example",
    `RECURRENCE-ID:202610${String(21 + (index % 5)).padStart(2, "0")}T150000Z`,
    "DTSTART:20261021T150000Z",
    "DTEND:20261021T160000Z",
    "END:VEVENT",
  ]).flat();
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//External//EN",
    `METHOD:${input.method ?? "REQUEST"}`,
    ...vevent,
    ...overrides,
    "END:VCALENDAR",
  ].join("\r\n");
}

describe("parseInboundInvitation", () => {
  it("reads METHOD, UID, SEQUENCE, organizer and the VEVENT of a REQUEST", () => {
    const invitation = parseInboundInvitation(ics({ sequence: 3 }));
    expect(invitation).toMatchObject({
      method: "REQUEST",
      uid: "launch@external.example",
      sequence: 3,
      organizerEmail: "olga@external.example",
      organizerName: "Olga Organizer",
      event: {
        title: "Launch review",
        startsAt: new Date("2026-10-20T15:00:00.000Z"),
        attendees: [expect.objectContaining({ email: "rita@helix.test" })],
      },
    });
  });

  it("accepts CANCEL without requiring the full event body", () => {
    expect(parseInboundInvitation(ics({ method: "CANCEL", sequence: 4 }))).toMatchObject({
      method: "CANCEL",
      uid: "launch@external.example",
      sequence: 4,
    });
  });

  it("rejects other methods, malformed, oversized and over-complex calendars", () => {
    expect(parseInboundInvitation(ics({ method: "REPLY" }))).toBeNull();
    expect(parseInboundInvitation(ics({ method: "PUBLISH" }))).toBeNull();
    expect(parseInboundInvitation("BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBROKEN")).toBeNull();
    expect(parseInboundInvitation("not a calendar")).toBeNull();
    expect(
      parseInboundInvitation(ics({ extra: [`DESCRIPTION:${"x".repeat(1024 * 1024)}`] })),
    ).toBeNull();
    expect(parseInboundInvitation(ics({ vevents: 1_001 }))).toBeNull();
    expect(
      parseInboundInvitation(ics({}).replace("ORGANIZER;CN=Olga Organizer:mailto:", "X-NO:")),
    ).toBeNull();
  });

  it("dedupes repeated calendar parts and ignores non-calendar attachments", () => {
    const body = Buffer.from(ics({}));
    expect(
      extractInboundInvitations([
        { contentType: "text/calendar", content: body },
        { contentType: "application/ics", content: body },
        { contentType: "text/plain", content: body },
        { contentType: "text/calendar", content: Buffer.from("garbage") },
      ]),
    ).toHaveLength(1);
  });
});

describe("CalendarInvitationImporter", () => {
  const sql = {
    begin: (callback: () => Promise<unknown>) => callback(),
  } as unknown as postgres.Sql;
  const delivery = {
    orgId: "org-1",
    messageId: "message-1",
    recipients: [{ orgId: "org-1", actorId: "actor-1", address: "rita@helix.test" }],
    attachments: [{ contentType: "text/calendar", content: Buffer.from(ics({})) }],
  };

  function store(): Pick<
    CalendarStore,
    "createEvent" | "updateEvent" | "deleteEvent" | "getEventForActor"
  > {
    return {
      createEvent: vi.fn(),
      updateEvent: vi.fn(),
      deleteEvent: vi.fn(),
      getEventForActor: vi.fn(),
    };
  }

  it("does nothing when the tenant flag is off", async () => {
    const calendar = store();
    const isEnabled = vi.fn(async () => false);
    await new CalendarInvitationImporter({ sql, store: calendar, isEnabled }).importInvitations(
      delivery,
    );
    expect(isEnabled).toHaveBeenCalledWith("org-1");
    expect(calendar.createEvent).not.toHaveBeenCalled();
    expect(calendar.getEventForActor).not.toHaveBeenCalled();
  });

  it("skips the flag lookup when the message carries no invitation", async () => {
    const isEnabled = vi.fn(async () => true);
    await new CalendarInvitationImporter({ sql, store: store(), isEnabled }).importInvitations({
      ...delivery,
      attachments: [{ contentType: "text/calendar", content: Buffer.from("garbage") }],
    });
    expect(isEnabled).not.toHaveBeenCalled();
  });

  it("logs and swallows import failures", async () => {
    const warn = vi.fn();
    const importer = new CalendarInvitationImporter({
      sql,
      store: store(),
      isEnabled: async () => {
        throw new Error("config store down");
      },
      logger: { warn },
    });
    await expect(importer.importInvitations(delivery)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", messageId: "message-1" }),
      expect.stringContaining("mail delivery continues"),
    );
  });
});
