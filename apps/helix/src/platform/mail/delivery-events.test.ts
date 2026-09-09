import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { signWebhookPayload } from "../webhooks/signatures.js";
import { registerMailDeliveryEventRoutes, type MailDeliveryEventInput } from "./delivery-events.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const providerId = "22222222-2222-4222-8222-222222222222";
const secret = "independent-feedback-secret";
const now = new Date("2026-09-02T12:00:00.000Z");

function provider() {
  return {
    id: providerId,
    orgId,
    name: "mailgun",
    kind: "mailgun" as const,
    enabled: true,
    isDefault: true,
    config: {},
    secretRef: "send-secret",
    webhookSecretRef: "feedback-secret",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function payload(providerEventId = "event-1") {
  return JSON.stringify({
    providerEventId,
    source: "provider",
    kind: "bounced",
    retryClass: "permanent",
    recipient: "User@Example.com",
    providerMessageId: "provider-message-1",
    occurredAt: now.toISOString(),
    diagnostic: "550 mailbox unavailable",
  });
}

describe("mail delivery feedback", () => {
  it("rejects missing, stale, and tampered signatures before mutation", async () => {
    const record = vi.fn();
    const app = fastify();
    registerMailDeliveryEventRoutes(app, {
      store: { record },
      providerStore: { getProvider: async () => provider() },
      resolveSecret: async () => secret,
      now: () => now,
    });
    await app.ready();
    const url = `/internal/mail/delivery-events/${orgId}/${providerId}`;
    const contentType = { "content-type": "application/json" };
    expect(
      (await app.inject({ method: "POST", url, payload: payload(), headers: contentType }))
        .statusCode,
    ).toBe(401);
    const stale = signWebhookPayload({
      payload: payload(),
      secret,
      timestamp: now.getTime() - 301_000,
    }).header;
    expect(
      (await app.inject({ method: "POST", url, payload: payload(), headers: { ...contentType, "x-helix-signature": stale } }))
        .statusCode,
    ).toBe(401);
    const valid = signWebhookPayload({ payload: payload(), secret, timestamp: now }).header;
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload: payload("tampered"),
          headers: { ...contentType, "x-helix-signature": valid },
        })
      ).statusCode,
    ).toBe(401);
    expect(record).not.toHaveBeenCalled();
    await app.close();
  });

  it("normalizes a signed hard bounce and makes provider replay idempotent", async () => {
    let duplicate = false;
    const record = vi.fn(async (input: MailDeliveryEventInput) => ({
      id: "33333333-3333-4333-8333-333333333333",
      outboundId: "44444444-4444-4444-8444-444444444444",
      providerId,
      providerEventId: input.providerEventId,
      source: input.source,
      kind: input.kind,
      retryClass: input.retryClass,
      recipient: input.recipient,
      diagnostic: input.diagnostic ?? null,
      occurredAt: input.occurredAt,
      duplicate: duplicate ? true : ((duplicate = true), false),
    }));
    const app = fastify();
    registerMailDeliveryEventRoutes(app, {
      store: { record },
      providerStore: { getProvider: async () => provider() },
      resolveSecret: async () => secret,
      now: () => now,
    });
    await app.ready();
    const raw = payload();
    const header = signWebhookPayload({ payload: raw, secret, timestamp: now }).header;
    const request = {
      method: "POST" as const,
      url: `/internal/mail/delivery-events/${orgId}/${providerId}`,
      payload: raw,
      headers: { "content-type": "application/json", "x-helix-signature": header },
    };
    expect((await app.inject(request)).statusCode).toBe(202);
    expect((await app.inject(request)).statusCode).toBe(200);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId,
        providerId,
        kind: "bounced",
        retryClass: "permanent",
        recipient: "user@example.com",
      }),
    );
    await app.close();
  });
});
