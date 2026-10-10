import { describe, expect, it } from "vitest";
import { shouldSkipVacationResponse } from "./core/thread-projection.js";

describe("vacation loop-prevention", () => {
  it("does not auto-reply to mailer-daemon", () => {
    expect(shouldSkipVacationResponse({ senderEmail: "mailer-daemon@mx.example.com" })).toBe(true);
  });

  it("does not auto-reply to no-reply senders", () => {
    expect(shouldSkipVacationResponse({ senderEmail: "no-reply@news.example.com" })).toBe(true);
    expect(shouldSkipVacationResponse({ senderEmail: "noreply@news.example.com" })).toBe(true);
  });

  it("does not auto-reply to bulk Precedence headers", () => {
    expect(
      shouldSkipVacationResponse({
        senderEmail: "list@example.com",
        headers: { Precedence: "bulk" },
      }),
    ).toBe(true);
  });

  it("does not auto-reply to Auto-Submitted messages", () => {
    expect(
      shouldSkipVacationResponse({
        senderEmail: "bot@example.com",
        headers: { "Auto-Submitted": "auto-replied" },
      }),
    ).toBe(true);
  });

  it("does not chain auto-replies", () => {
    expect(
      shouldSkipVacationResponse({
        senderEmail: "colleague@example.com",
        isAutoReply: true,
      }),
    ).toBe(true);
  });

  it("does not auto-reply to mailing lists", () => {
    for (const headers of [
      { "list-id": "<team.lists.example.com>" },
      { "List-Unsubscribe": "<mailto:leave@lists.example.com>" },
    ]) {
      expect(shouldSkipVacationResponse({ senderEmail: "list@example.com", headers })).toBe(true);
    }
  });

  it("honours X-Auto-Response-Suppress OOF and All", () => {
    for (const value of ["OOF", "DR, OOF, AutoReply", "All"]) {
      expect(
        shouldSkipVacationResponse({
          senderEmail: "sender@example.com",
          headers: { "x-auto-response-suppress": value },
        }),
      ).toBe(true);
    }
    expect(
      shouldSkipVacationResponse({
        senderEmail: "sender@example.com",
        headers: { "x-auto-response-suppress": "DR" },
      }),
    ).toBe(false);
  });

  it("treats Auto-Submitted parameters and lower-case keys like RFC 3834", () => {
    expect(
      shouldSkipVacationResponse({
        senderEmail: "bot@example.com",
        headers: { "auto-submitted": "auto-generated; owner-email=x@y" },
      }),
    ).toBe(true);
    expect(
      shouldSkipVacationResponse({
        senderEmail: "human@example.com",
        headers: { "auto-submitted": "no" },
      }),
    ).toBe(false);
  });

  it("never answers bounces, itself, or mail that did not name the user", () => {
    expect(
      shouldSkipVacationResponse({
        senderEmail: "a@example.com",
        headers: { "return-path": "<>" },
      }),
    ).toBe(true);
    expect(
      shouldSkipVacationResponse({ senderEmail: "Me@Helix.test", ownAddresses: ["me@helix.test"] }),
    ).toBe(true);
    expect(
      shouldSkipVacationResponse({
        senderEmail: "friend@example.com",
        ownAddresses: ["me@helix.test"],
        visibleRecipients: ["everyone@lists.example.com"],
      }),
    ).toBe(true);
    expect(
      shouldSkipVacationResponse({
        senderEmail: "friend@example.com",
        ownAddresses: ["me@helix.test"],
        visibleRecipients: ["ME@helix.test"],
      }),
    ).toBe(false);
  });

  it("allows ordinary human senders", () => {
    expect(shouldSkipVacationResponse({ senderEmail: "friend@example.com" })).toBe(false);
  });
});
