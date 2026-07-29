import { describe, expect, it } from "vitest";
import { createInboundDeliveryDedup, normalizeInboundMessageId } from "./inbound-dedup.js";

describe("inbound delivery dedup", () => {
  it("is stable across envelope casing and recipient order", () => {
    const base = {
      orgId: "org-1",
      raw: "same raw message",
      messageId: " <NOTICE@Example.COM> ",
      receivedAt: new Date("2026-07-28T12:00:00.000Z"),
    };
    const first = createInboundDeliveryDedup({
      ...base,
      envelopeFrom: "Sender@Example.net",
      envelopeTo: ["B@example.com", "a@example.com"],
    });
    const second = createInboundDeliveryDedup({
      ...base,
      envelopeFrom: "sender@example.NET",
      envelopeTo: ["a@EXAMPLE.com", "b@example.com", "a@example.com"],
    });
    expect(first.key).toBe(second.key);
    expect(first).toMatchObject({
      normalizedMessageId: "<notice@example.com>",
      envelopeFrom: "sender@example.net",
      envelopeTo: ["a@example.com", "b@example.com"],
    });
  });

  it("changes when organization, tenant envelope, or raw digest changes", () => {
    const base = {
      orgId: "org-1",
      raw: "raw",
      messageId: "<id@example.com>",
      envelopeFrom: "sender@example.net",
      envelopeTo: ["a@example.com"],
      receivedAt: new Date(),
    };
    const key = createInboundDeliveryDedup(base).key;
    expect(createInboundDeliveryDedup({ ...base, orgId: "org-2" }).key).not.toBe(key);
    expect(createInboundDeliveryDedup({ ...base, envelopeTo: ["b@example.com"] }).key).not.toBe(
      key,
    );
    expect(createInboundDeliveryDedup({ ...base, raw: "changed" }).key).not.toBe(key);
  });

  it("uses only syntactically usable Message-IDs", () => {
    expect(normalizeInboundMessageId("<Good@Example.COM>")).toBe("<good@example.com>");
    expect(normalizeInboundMessageId("not-a-message-id")).toBeNull();
    expect(normalizeInboundMessageId("<missing-domain>")).toBeNull();
    expect(normalizeInboundMessageId(`<${"a".repeat(1_000)}@example.com>`)).toBeNull();
  });
});
