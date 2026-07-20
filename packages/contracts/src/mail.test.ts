import { describe, expect, it } from "vitest";
import {
  mailFilterSchema,
  mailSendInputSchema,
  mailSpamInputSchema,
  mailThreadRowSchema,
} from "./mail.js";

describe("mail contracts", () => {
  it("parses a minimal send input and applies array defaults", () => {
    const parsed = mailSendInputSchema.parse({
      to: [{ address: "a@b.com" }],
      subject: "hi",
      bodyText: "body",
    });
    expect(parsed.cc).toEqual([]);
    expect(parsed.bcc).toEqual([]);
    expect(parsed.attachments).toEqual([]);
  });

  it("rejects a send with no recipients", () => {
    expect(() => mailSendInputSchema.parse({ to: [], subject: "x", bodyText: "y" })).toThrow();
  });

  it("validates a thread-row projection shape", () => {
    const row = mailThreadRowSchema.parse({
      threadId: "t1",
      messageId: "m1",
      subject: "s",
      from: "A",
      fromEmail: "a@b.com",
      preview: "p",
      time: "now",
      unread: true,
      starred: false,
      hasAttachment: false,
      messageCount: 1,
      labels: [],
      category: "primary",
      folder: "inbox",
      snoozedUntil: null,
    });
    expect(row.unread).toBe(true);
  });

  it("defaults spam:true in mailSpamInputSchema", () => {
    expect(
      mailSpamInputSchema.parse({ threadId: "11111111-1111-1111-1111-111111111111" }).spam,
    ).toBe(true);
  });

  it("filter schema round-trips ISO timestamps as strings", () => {
    const f = mailFilterSchema.parse({
      id: "f1",
      name: "n",
      enabled: true,
      priority: 100,
      criteria: {},
      actions: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(f.priority).toBe(100);
  });
});
