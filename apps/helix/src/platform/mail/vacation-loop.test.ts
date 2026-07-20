import { describe, expect, it } from "vitest";
import { shouldSkipVacationResponse } from "./core/thread-projection.js";

describe("vacation loop-prevention", () => {
  it("does not auto-reply to mailer-daemon", () => {
    expect(shouldSkipVacationResponse({ senderEmail: "mailer-daemon@mx.example.com" })).toBe(
      true,
    );
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

  it("allows ordinary human senders", () => {
    expect(shouldSkipVacationResponse({ senderEmail: "friend@example.com" })).toBe(false);
  });
});
