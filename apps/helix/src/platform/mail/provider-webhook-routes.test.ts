import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { signWebhookPayload } from "../webhooks/signatures.js";
import { InMemoryOutboundProviderStore } from "./admin-store.js";
import { InMemoryMailDeliveryEventStore } from "./delivery-events.js";
import { registerMailProviderWebhookRoutes } from "./provider-webhook-routes.js";

const orgA = "11111111-1111-4111-8111-111111111111";
const orgB = "22222222-2222-4222-8222-222222222222";
const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const now = new Date("2026-07-28T12:00:00.000Z");

describe("managed provider webhook route", () => {
  it("captures raw bytes, resolves the signing secret at call time, and scopes provider lookup", async () => {
    const providerStore = new InMemoryOutboundProviderStore();
    const provider = await providerStore.createProvider({
      orgId: orgA,
      name: "mailgun",
      kind: "mailgun",
      enabled: true,
      isDefault: true,
      config: { domain: "mg.example" },
      secretRef: "DELIVERY_SECRET",
      webhookSecretRef: "WEBHOOK_SECRET",
      createdBy: actor,
    });
    const rawBody = Buffer.from(
      JSON.stringify({
        "event-data": {
          id: "event-1",
          event: "delivered",
          recipient: "recipient@example.net",
          timestamp: now.getTime() / 1000,
          message: { headers: { "message-id": "provider-message-1" } },
        },
      }),
    );
    const signature = signWebhookPayload({
      payload: rawBody,
      secret: "rotated-at-call-time",
      timestamp: Date.now(),
    });
    const resolveSecret = vi.fn().mockResolvedValue("rotated-at-call-time");
    const app = fastify();
    await registerMailProviderWebhookRoutes(app, {
      providerStore,
      deliveryStore: new InMemoryMailDeliveryEventStore(),
      secrets: { resolveSecret },
    });
    await app.ready();

    const accepted = await app.inject({
      method: "POST",
      url: `/webhooks/mail/providers/${orgA}/${provider.id}`,
      headers: {
        "content-type": "application/json",
        "x-helix-signature": signature.header,
      },
      payload: rawBody,
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ accepted: true, duplicate: false });
    expect(resolveSecret).toHaveBeenCalledWith("WEBHOOK_SECRET");

    const crossOrg = await app.inject({
      method: "POST",
      url: `/webhooks/mail/providers/${orgB}/${provider.id}`,
      headers: {
        "content-type": "application/json",
        "x-helix-signature": signature.header,
      },
      payload: rawBody,
    });
    expect(crossOrg.statusCode).toBe(404);
    await app.close();
  });
});
