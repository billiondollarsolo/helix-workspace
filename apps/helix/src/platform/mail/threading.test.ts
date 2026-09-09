import { describe, expect, it } from "vitest";
import {
  normalizeMessageId,
  normalizeMessageIds,
  normalizeProviderDeliveryId,
  prepareOutboundEnvelope,
  threadReferenceIds,
} from "./threading.js";

describe("RFC mail threading", () => {
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
