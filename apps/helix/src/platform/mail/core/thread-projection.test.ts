import { describe, expect, it } from "vitest";
import {
  folderPredicate,
  matchesFilterCriteria,
  projectThreadRow,
  shouldSkipVacationResponse,
  type ThreadProjectionSource,
} from "./thread-projection.js";

const now = new Date("2026-06-01T12:00:00.000Z");

function base(overrides: Partial<ThreadProjectionSource> = {}): ThreadProjectionSource {
  return {
    deletedAt: null,
    spamAt: null,
    archivedAt: null,
    threadArchivedAt: null,
    starred: false,
    snoozedUntil: null,
    hasOutbound: false,
    outboundStatus: null,
    ...overrides,
  };
}

describe("folderPredicate", () => {
  it("classifies inbox/spam/archive/starred/snoozed/sent/drafts/trash", () => {
    expect(folderPredicate("inbox", base(), now)).toBe(true);
    expect(folderPredicate("spam", base({ spamAt: now }), now)).toBe(true);
    expect(folderPredicate("archive", base({ archivedAt: now }), now)).toBe(true);
    expect(folderPredicate("starred", base({ starred: true }), now)).toBe(true);
    expect(
      folderPredicate(
        "snoozed",
        base({ snoozedUntil: new Date("2026-07-01T00:00:00.000Z") }),
        now,
      ),
    ).toBe(true);
    expect(folderPredicate("sent", base({ hasOutbound: true }), now)).toBe(true);
    expect(folderPredicate("drafts", base({ outboundStatus: "queued" }), now)).toBe(true);
    expect(folderPredicate("drafts", base({ isDraft: true }), now)).toBe(true);
    expect(folderPredicate("trash", base({ deletedAt: now }), now)).toBe(true);
  });

  it("excludes outbound threads from inbox", () => {
    expect(folderPredicate("inbox", base({ hasOutbound: true }), now)).toBe(false);
  });
});

describe("projectThreadRow", () => {
  it("projects a UI row with truncated preview and folder", () => {
    const row = projectThreadRow({
      threadId: "t1",
      messageId: "m1",
      subject: "Hello",
      fromName: "Ada",
      fromEmail: "ada@example.com",
      body: "  long   body  ",
      sentAt: now,
      unread: true,
      starred: false,
      hasAttachment: false,
      messageCount: 2,
      labels: ["vip"],
      category: "primary",
      snoozedUntil: null,
      projection: base(),
      now,
    });
    expect(row.from).toBe("Ada");
    expect(row.preview).toBe("long body");
    expect(row.folder).toBe("inbox");
    expect(row.unread).toBe(true);
  });
});

describe("matchesFilterCriteria", () => {
  const message = {
    from: { address: "ada@example.com" },
    to: [{ address: "bob@example.com" }],
    subject: "Quarterly report",
    bodyText: "Please review the deck",
    attachments: [{ filename: "a.pdf" }],
  };

  it("matches and rejects criteria fields", () => {
    expect(matchesFilterCriteria(message, { fromContains: "ada@" })).toBe(true);
    expect(matchesFilterCriteria(message, { fromContains: "z@" })).toBe(false);
    expect(matchesFilterCriteria(message, { subjectContains: "quarterly" })).toBe(true);
    expect(matchesFilterCriteria(message, { bodyContains: "deck" })).toBe(true);
    expect(matchesFilterCriteria(message, { hasAttachment: true })).toBe(true);
    expect(matchesFilterCriteria(message, { hasAttachment: false })).toBe(false);
  });
});

describe("shouldSkipVacationResponse", () => {
  it("skips mailer-daemon / no-reply / bulk / auto-submitted", () => {
    expect(shouldSkipVacationResponse({ senderEmail: "mailer-daemon@x.com" })).toBe(true);
    expect(shouldSkipVacationResponse({ senderEmail: "no-reply@x.com" })).toBe(true);
    expect(
      shouldSkipVacationResponse({
        senderEmail: "a@b.com",
        headers: { precedence: "bulk" },
      }),
    ).toBe(true);
    expect(
      shouldSkipVacationResponse({
        senderEmail: "a@b.com",
        headers: { "auto-submitted": "auto-replied" },
      }),
    ).toBe(true);
    expect(shouldSkipVacationResponse({ senderEmail: "a@b.com", isAutoReply: true })).toBe(
      true,
    );
    expect(shouldSkipVacationResponse({ senderEmail: "friend@example.com" })).toBe(false);
  });
});
