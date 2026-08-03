import fastify from "fastify";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { signWebhookPayload } from "../webhooks/signatures.js";
import { InMemoryOutboundProviderStore } from "./admin-store.js";
import { InMemoryMailDeliveryEventStore } from "./delivery-events.js";
import { OutboundMailDispatcher, type OutboundMailTransport } from "./outbound.js";
import type { MailStore } from "./store.js";
import type { MailOutboundEnvelope, MailOutboundRecord } from "./types.js";
import {
  ProviderWebhookBodyTooLargeError,
  readBoundedPayload,
  registerMailProviderWebhookRoutes,
} from "./provider-webhook-routes.js";

const orgA = "11111111-1111-4111-8111-111111111111";
const orgB = "22222222-2222-4222-8222-222222222222";
const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const now = new Date("2026-07-28T12:00:00.000Z");

describe("managed provider webhook route", () => {
  it("stops buffering as soon as the raw-body limit is exceeded", async () => {
    const payload = Readable.from([Buffer.alloc(700), Buffer.alloc(700), Buffer.alloc(700)]);

    await expect(readBoundedPayload(payload, 1_024)).rejects.toBeInstanceOf(
      ProviderWebhookBodyTooLargeError,
    );
    expect(payload.destroyed).toBe(true);
  });

  it("preserves exact raw bytes below the limit", async () => {
    const payload = Readable.from([Buffer.from("signed"), Buffer.from("-body")]);
    await expect(readBoundedPayload(payload, 11)).resolves.toEqual(Buffer.from("signed-body"));
  });

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

  it("hard-bounce webhook through the real route suppresses the recipient and blocks outbound dispatch", async () => {
    const providerStore = new InMemoryOutboundProviderStore();
    const deliveryStore = new InMemoryMailDeliveryEventStore();
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
        signature: { timestamp: "unused", token: "unused", signature: "unused" },
        "event-data": {
          id: "hard-bounce-route-1",
          event: "failed",
          severity: "permanent",
          recipient: "User@Example.NET",
          timestamp: now.getTime() / 1000,
          message: { headers: { "message-id": "provider-message-bounce-1" } },
          "delivery-status": { code: 550, description: "mailbox unknown" },
        },
      }),
    );
    const signature = signWebhookPayload({
      payload: rawBody,
      secret: "webhook-secret",
      timestamp: Date.now(),
    });
    const app = fastify();
    await registerMailProviderWebhookRoutes(app, {
      providerStore,
      deliveryStore,
      secrets: { resolveSecret: async () => "webhook-secret" },
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
    expect(accepted.json()).toMatchObject({
      accepted: true,
      duplicate: false,
      suppressed: true,
    });

    const suppressions = await deliveryStore.findActiveSuppressions(orgA, ["USER@EXAMPLE.NET"]);
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0]).toMatchObject({
      orgId: orgA,
      normalizedRecipient: "user@example.net",
      reason: "hard_bounce",
      clearedAt: null,
    });
    expect(await deliveryStore.findActiveSuppressions(orgB, ["user@example.net"])).toHaveLength(0);

    const forged = await app.inject({
      method: "POST",
      url: `/webhooks/mail/providers/${orgA}/${provider.id}`,
      headers: {
        "content-type": "application/json",
        "x-helix-signature": "t=1,v1=deadbeef",
      },
      payload: rawBody,
    });
    expect(forged.statusCode).toBe(401);

    const envelope: MailOutboundEnvelope = {
      from: { address: "alice@example.com" },
      to: [{ address: "User@Example.NET" }],
      cc: [],
      bcc: [],
      subject: "Hi",
      text: "Hello",
      attachments: [],
    };
    const record: MailOutboundRecord = {
      id: "out-suppressed-1",
      orgId: orgA,
      actorId: actor,
      messageId: "m1",
      threadId: "t1",
      outboxId: "ob1",
      status: "sending",
      envelope,
      undoUntil: new Date("2026-05-20T00:00:00.000Z"),
      sentAt: null,
      cancelledAt: null,
      failedAt: null,
      lastError: null,
      providerMessageId: null,
      deliveryMetadata: {},
      attemptCount: 0,
      nextAttemptAt: null,
      deadLetteredAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const transportFor = vi.fn((): OutboundMailTransport => {
      throw new Error("transport must not be resolved for suppressed recipients");
    });
    const markOutboundDeadLettered = vi.fn().mockImplementation(async (input) => ({
      ...record,
      status: "failed",
      lastError: input.lastError,
      deadLetteredAt: now,
    }));
    const store = {
      markOutboundSending: vi.fn().mockResolvedValue(record),
      markOutboundDeadLettered,
    } as unknown as MailStore;

    const result = await new OutboundMailDispatcher(store, transportFor, {
      suppressionStore: deliveryStore,
    }).dispatch(record.id);

    expect(transportFor).not.toHaveBeenCalled();
    expect(result?.lastError).toContain("MAIL_RECIPIENT_SUPPRESSED");
    await app.close();
  });
});
