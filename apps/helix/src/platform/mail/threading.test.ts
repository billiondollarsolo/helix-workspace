import { describe, expect, it } from "vitest";
import {
  normalizeMessageId,
  normalizeMessageIds,
  normalizeProviderDeliveryId,
  outboundThreadReferences,
  isSesSmtpHost,
  prepareOutboundEnvelope,
  threadReferenceIds,
} from "./threading.js";

describe("RFC mail threading", () => {
  it("keeps the persisted identity in replies after SES rewrites the delivered Message-ID", () => {
    const messageId = "<original@workspace.example>";
    const references = outboundThreadReferences({ messageId }, true);
    const deliveredMessageId = "<provider-generated@us-east-2.amazonses.com>";
    // A recipient's reply inherits the received References and then its parent ID.
    expect(
      threadReferenceIds({
        inReplyTo: deliveredMessageId,
        references: [...(references ?? []), deliveredMessageId],
      }),
    ).toContain(messageId);
    expect(outboundThreadReferences({ messageId }, false)).toBeUndefined();
  });

  it("retains the stable reference once and bounds long ancestry without losing it", () => {
    const messageId = "<current@workspace.example>";
    const references = outboundThreadReferences(
      {
        messageId,
        references: [
          ...Array.from({ length: 100 }, (_, index) => `<ancestor-${String(index)}@example.test>`),
          messageId,
        ],
      },
      true,
    );
    expect(references?.at(-1)).toBe(messageId);
    expect(references?.filter((id) => id === messageId)).toHaveLength(1);
    expect(Buffer.byteLength(references?.join(" ") ?? "")).toBeLessThanOrEqual(998);
    expect(normalizeMessageIds(references?.join(" "))).toEqual(references);
  });

  it("recognizes SES SMTP and Mail Manager hosts without changing unrelated relays", () => {
    expect(isSesSmtpHost("email-smtp.us-east-2.amazonaws.com")).toBe(true);
    expect(isSesSmtpHost("ingress.fips.region.mail-manager-smtp.amazonaws.com")).toBe(true);
    expect(isSesSmtpHost("EMAIL-SMTP.US-EAST-2.AMAZONAWS.COM")).toBe(true);
    expect(isSesSmtpHost("email-smtp.us-east-2.amazonaws.com.example.test")).toBe(false);
    expect(isSesSmtpHost("relay.example.test")).toBe(false);
  });

  it("canonicalizes domains without changing the case-sensitive local part", () => {
    expect(normalizeMessageId("  <Case.Sensitive@EXAMPLE.COM> ")).toBe(
      "<Case.Sensitive@example.com>",
    );
    expect(normalizeMessageId("bare@Example.COM")).toBe("<bare@example.com>");
  });

  it("rejects ambiguous, injected, malformed, and oversized IDs", () => {
    expect(normalizeMessageId("<one@example.com> <two@example.com>")).toBeNull();
    expect(normalizeMessageId("<one@example.com\r\nBcc: victim@example.com>")).toBeNull();
    expect(normalizeMessageId("missing-domain")).toBeNull();
    expect(normalizeMessageId(`${"a".repeat(999)}@example.com`)).toBeNull();
    expect(normalizeProviderDeliveryId("provider\nforgery")).toBeNull();
  });

  it("chooses the explicit parent, then nearest References, deterministically", () => {
    expect(
      threadReferenceIds({
        inReplyTo: "<parent@EXAMPLE.COM>",
        references: [
          "<oldest@example.com>",
          "<parent@example.com>",
          "<nearest@example.com> <nearer@example.com>",
        ],
      }),
    ).toEqual([
      "<parent@example.com>",
      "<nearer@example.com>",
      "<nearest@example.com>",
      "<oldest@example.com>",
    ]);
    expect(normalizeMessageIds(["<a@EXAMPLE.COM>", "a@example.com"])).toEqual(["<a@example.com>"]);
  });

  it("pins one stable outbound Message-ID and canonical reply headers", () => {
    const prepared = prepareOutboundEnvelope({
      from: { address: "alice@Workspace.EXAMPLE" },
      to: [{ address: "bob@example.net" }],
      cc: [],
      bcc: [],
      subject: "Re: plan",
      text: "Approved",
      attachments: [],
      inReplyTo: "parent@EXAMPLE.NET",
      references: ["<root@EXAMPLE.NET>", "<parent@example.net>"],
    });

    expect(prepared.messageId).toMatch(/^<[0-9a-f-]+@workspace\.example>$/u);
    expect(prepared.inReplyTo).toBe("<parent@example.net>");
    expect(prepared.references).toEqual(["<root@example.net>", "<parent@example.net>"]);
    expect(prepareOutboundEnvelope(prepared)).toEqual(prepared);
  });
});
