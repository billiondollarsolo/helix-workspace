import { describe, expect, it } from "vitest";
import {
  mailFilterSchema,
  mailReceivingDomainCreateInputSchema,
  mailReceivingDomainCreateResultSchema,
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

  it("validates the receiving-domain lifecycle projection without a token hash", () => {
    const result = mailReceivingDomainCreateResultSchema.parse({
      domain: {
        id: "11111111-1111-4111-8111-111111111111",
        orgId: "22222222-2222-4222-8222-222222222222",
        domain: "xn--bcher-kva.example",
        status: "pending",
        verifiedAt: null,
        catchAllActorId: null,
        createdBy: "33333333-3333-4333-8333-333333333333",
        createdAt: "2026-07-28T12:00:00.000Z",
        updatedAt: "2026-07-28T12:00:00.000Z",
      },
      verification: {
        dnsName: "_helix-verification.xn--bcher-kva.example",
        dnsValue: "helix-domain-verification=one-time-token",
      },
    });
    expect(result.domain.status).toBe("pending");
    expect(result.domain).not.toHaveProperty("verificationTokenHash");
  });

  it("rejects unknown receiving-domain states and malformed catch-all actors", () => {
    expect(() =>
      mailReceivingDomainCreateInputSchema.parse({
        domain: "example.com",
        catchAllActorId: "not-a-uuid",
      }),
    ).toThrow();
    expect(() =>
      mailReceivingDomainCreateResultSchema.parse({
        domain: {
          id: "11111111-1111-4111-8111-111111111111",
          orgId: "22222222-2222-4222-8222-222222222222",
          domain: "example.com",
          status: "provisioning",
          verifiedAt: null,
          catchAllActorId: null,
          createdBy: null,
          createdAt: "2026-07-28T12:00:00.000Z",
          updatedAt: "2026-07-28T12:00:00.000Z",
        },
        verification: {
          dnsName: "_helix-verification.example.com",
          dnsValue: "helix-domain-verification=token",
        },
      }),
    ).toThrow();
  });
});
