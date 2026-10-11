import { describe, expect, it, vi } from "vitest";
import { ingestRawMail, type InboundCalendarInvitationImporter } from "./ingest.js";
import type { MailStore } from "./store.js";
import type { MailMessageInput } from "./types.js";

const recipients = [
  { orgId: "org-1", actorId: "rita", address: "rita@helix.test" },
  { orgId: "org-1", actorId: "sam", address: "sam@helix.test" },
];
const calendarBody = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR";
const raw = [
  "From: Olga <olga@external.example>",
  "To: rita@helix.test, sam@helix.test",
  "Subject: Invitation",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="imip"',
  "",
  "--imip",
  "Content-Type: text/plain",
  "",
  "Invited.",
  "--imip",
  "Content-Type: text/calendar; method=REQUEST",
  "",
  calendarBody,
  "--imip--",
  "",
].join("\r\n");

function mailStore(deliveredActorIds: readonly string[]): MailStore {
  return {
    insertInboundMessage: async (_message: MailMessageInput) => ({
      created: true,
      deliveredActorIds,
      threadId: "thread-1",
      messageId: "message-1",
      attachmentObjectIds: [],
    }),
    listFilters: async () => [],
    getActiveVacation: async () => null,
    updateThreadState: async () => {},
    recordSpamFeedback: async () => {},
  } as unknown as MailStore;
}

const authenticator = {
  authenticate: async () => ({ spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" }),
};

describe("inbound calendar invitation hook", () => {
  it("offers calendar parts for delivered mailboxes only", async () => {
    const importInvitations = vi.fn<InboundCalendarInvitationImporter["importInvitations"]>(
      async () => {},
    );
    await ingestRawMail({
      store: mailStore(["rita"]),
      input: { orgId: "org-1", recipients, raw },
      authenticator,
      calendarInvitations: { importInvitations },
    });
    expect(importInvitations).toHaveBeenCalledTimes(1);
    const delivery = importInvitations.mock.calls[0]?.[0];
    expect(delivery).toMatchObject({
      orgId: "org-1",
      messageId: "message-1",
      recipients: [recipients[0]],
    });
    expect(
      delivery?.attachments.map((attachment) => [
        attachment.contentType,
        attachment.content.toString("utf8").trim(),
      ]),
    ).toEqual([["text/calendar", calendarBody]]);
  });

  it("keeps delivery successful when the importer rejects", async () => {
    const result = await ingestRawMail({
      store: mailStore(["rita", "sam"]),
      input: { orgId: "org-1", recipients, raw },
      authenticator,
      calendarInvitations: {
        importInvitations: async () => {
          throw new Error("calendar unavailable");
        },
      },
    });
    expect(result.stored.deliveredActorIds).toEqual(["rita", "sam"]);
  });

  it("never imports invitations from spam-routed mail", async () => {
    const importInvitations = vi.fn(async () => {});
    const result = await ingestRawMail({
      store: mailStore(["rita"]),
      input: { orgId: "org-1", recipients, raw },
      authenticator,
      scanners: {
        spam: {
          scan: async () => ({
            score: 20,
            thresholdReportedBySpamd: 5,
            isSpam: true,
            symbols: [],
            evidence: {},
          }),
        },
        antivirus: {
          scan: async () => ({ infected: false, signature: null, scanned: true, evidence: {} }),
        },
      },
      calendarInvitations: { importInvitations },
    });
    expect(result.scan.routedToSpam).toBe(true);
    expect(importInvitations).not.toHaveBeenCalled();
  });
});
