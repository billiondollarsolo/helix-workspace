// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { MailThreadMessage } from "../api";
import { fieldsFromInit, recipientProblem, wireBody } from "./compose-fields";
import { composeHtmlToText, safeLinkHref, sanitizeComposeHtml } from "./compose-html";
import {
  canReplyAll,
  forwardSubject,
  replyParent,
  replyRecipients,
  replySubject,
} from "./reply-recipients";
import { scheduleSendPresets } from "./schedule-send";

describe("compose HTML", () => {
  it("keeps formatting and drops anything executable or remote", () => {
    const html = sanitizeComposeHtml(
      `<div style="text-align: center; position: fixed">Hi <b onclick="x()">there</b></div>` +
        `<script>alert(1)</script><img src="https://tracker.test/p.gif">` +
        `<a href="javascript:alert(1)">bad</a> <a href="https://helix.test/doc">good</a>` +
        `<span style="color: rgb(197, 34, 31); background: url(https://x.test)">red</span>`,
    );
    expect(html).toBe(
      `<div style="text-align: center">Hi <b>there</b></div>` +
        `<a>bad</a> <a href="https://helix.test/doc" target="_blank" rel="noopener noreferrer">good</a>` +
        `<span style="color: rgb(197, 34, 31)">red</span>`,
    );
  });

  it("turns formatted HTML into readable plain text", () => {
    expect(
      composeHtmlToText(
        "<div>Hello</div><ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>" +
          "<blockquote>quoted<br>line</blockquote><div><a href='https://helix.test'>docs</a></div>",
      ),
    ).toBe("Hello\n- one\n- two\n1. first\n> quoted\n> line\ndocs (https://helix.test)");
  });

  it("accepts web and email links only", () => {
    expect(safeLinkHref("helix.test/path")).toBe("https://helix.test/path");
    expect(safeLinkHref("sam@helix.test")).toBe("mailto:sam@helix.test");
    expect(safeLinkHref("javascript:alert(1)")).toBeNull();
    expect(safeLinkHref("  ")).toBeNull();
  });

  it("sends plain text mode without HTML", () => {
    const fields = fieldsFromInit({ body: "Line one\nLine two", plainText: true });
    expect(wireBody(fields)).toEqual({ bodyText: "Line one\nLine two" });
    expect(wireBody({ ...fields, plainText: false })).toEqual({
      bodyText: "Line one\nLine two",
      bodyHtml: "<div>Line one</div><div>Line two</div>",
    });
  });
});

describe("recipient validation", () => {
  it("names the field and the bad address", () => {
    const fields = fieldsFromInit({ to: "ok@helix.test", cc: ["nope", "also bad"] });
    expect(recipientProblem(fields)).toEqual({
      field: "cc",
      message: "Cc: nope, also bad aren't valid email addresses. Edit or remove them.",
    });
    expect(recipientProblem(fieldsFromInit({}))).toEqual({
      field: "to",
      message: "Add at least one recipient.",
    });
    expect(recipientProblem(fieldsFromInit({ bcc: "hidden@helix.test" }))).toBeNull();
  });
});

describe("schedule send presets", () => {
  // Friday 9 October 2026, 15:00 in New York.
  const friday = new Date("2026-10-09T19:00:00.000Z");

  it("offers tomorrow morning, tomorrow afternoon, and Monday morning in the person's zone", () => {
    const presets = scheduleSendPresets(friday, {
      timeZone: "America/New_York",
      workingHours: null,
    });
    expect(presets.map((preset) => [preset.label, preset.at.toISOString()])).toEqual([
      ["Tomorrow morning", "2026-10-10T12:00:00.000Z"],
      ["Tomorrow afternoon", "2026-10-10T17:00:00.000Z"],
      ["Monday morning", "2026-10-12T12:00:00.000Z"],
    ]);
  });

  it("starts at the working-hours start and skips Monday when tomorrow is Monday", () => {
    const sunday = new Date("2026-10-11T12:00:00.000Z");
    const presets = scheduleSendPresets(sunday, {
      timeZone: "UTC",
      workingHours: {
        enabled: true,
        days: [{ day: 1, start: "09:30", end: "12:00" }],
      },
    });
    expect(presets.map((preset) => [preset.label, preset.at.toISOString()])).toEqual([
      ["Tomorrow morning", "2026-10-12T09:30:00.000Z"],
      // The workday ends before 1 PM, so the afternoon slot starts the day.
      ["Tomorrow afternoon", "2026-10-12T09:30:00.000Z"],
    ]);
  });
});

function message(overrides: Partial<MailThreadMessage>): MailThreadMessage {
  return {
    id: "m",
    to: [],
    cc: [],
    bcc: [],
    sentAt: "2026-10-01T00:00:00.000Z",
    body: "",
    bodyFormat: "plain",
    hasAttachment: false,
    attachments: [],
    ...overrides,
  };
}

describe("reply recipients", () => {
  const own = new Set(["me@helix.test"]);
  const fromSamara = message({
    id: "m2",
    from: { address: "samara@example.com", name: "Samara" },
    to: [{ address: "me@helix.test" }, { address: "lee@example.com", name: "Lee" }],
    cc: [{ address: "kai@example.com" }, { address: "ME@helix.test" }],
  });
  const mine = message({
    id: "m3",
    from: { address: "me@helix.test" },
    to: [{ address: "samara@example.com", name: "Samara" }],
  });

  it("answers the latest message from someone else, never me", () => {
    expect(replyParent([fromSamara, mine], own)?.id).toBe("m2");
    const reply = replyRecipients(fromSamara, own, false);
    expect(reply.to.map((ref) => ref.displayName)).toEqual(["Samara"]);
    expect(reply.cc).toEqual([]);
  });

  it("Reply all adds the other recipients and drops my own addresses", () => {
    const all = replyRecipients(fromSamara, own, true);
    expect(all.to.map((ref) => ref.email)).toEqual(["samara@example.com", "lee@example.com"]);
    expect(all.cc.map((ref) => ref.email)).toEqual(["kai@example.com"]);
    expect(canReplyAll(fromSamara, own)).toBe(true);
  });

  it("uses Reply-To and replies to my own recipients when I sent the last message", () => {
    const withReplyTo = message({
      from: { address: "noreply@example.com" },
      replyTo: [{ address: "help@example.com" }],
    });
    expect(replyRecipients(withReplyTo, own, false).to.map((ref) => ref.email)).toEqual([
      "help@example.com",
    ]);
    expect(replyRecipients(mine, own, false).to.map((ref) => ref.email)).toEqual([
      "samara@example.com",
    ]);
    expect(canReplyAll(mine, own)).toBe(false);
  });

  it("prefixes subjects once", () => {
    expect(replySubject("Plans")).toBe("Re: Plans");
    expect(replySubject("RE: Plans")).toBe("RE: Plans");
    expect(forwardSubject("Fwd: Plans")).toBe("Fwd: Plans");
    expect(forwardSubject("FW: Plans")).toBe("FW: Plans");
    expect(forwardSubject("Re: Plans")).toBe("Fwd: Re: Plans");
  });
});
