import { describe, expect, it, vi } from "vitest";
import { signWebhookPayload } from "../webhooks/signatures.js";
import {
  clearMailSuppressionWithAudit,
  InMemoryMailDeliveryEventStore,
  MailDeliveryAlertMonitor,
  normalizeMailgunDeliveryEvent,
  ProviderWebhookVerificationError,
  verifyAndIngestProviderWebhook,
} from "./delivery-events.js";

const orgA = "11111111-1111-4111-8111-111111111111";
const orgB = "22222222-2222-4222-8222-222222222222";
const providerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const providerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const occurredAt = new Date("2026-07-28T12:00:00.000Z");

describe("signed managed-provider delivery webhooks", () => {
  it("verifies exact raw bytes and rejects modified or expired payloads", async () => {
    const raw = mailgunPayload("event-1", "failed", "permanent");
    const signature = signWebhookPayload({
      payload: raw,
      secret: "webhook-secret",
      timestamp: occurredAt,
    });
    const store = new InMemoryMailDeliveryEventStore();
    const valid = await verifyAndIngestProviderWebhook({
      orgId: orgA,
      providerId: providerA,
      providerKind: "mailgun",
      rawBody: raw,
      signatureHeader: signature.header,
      signingSecret: "webhook-secret",
      store,
      now: occurredAt,
    });
    expect(valid.suppressed).toBe(true);

    await expect(
      verifyAndIngestProviderWebhook({
        orgId: orgA,
        providerId: providerA,
        providerKind: "mailgun",
        rawBody: Buffer.concat([raw, Buffer.from(" ")]),
        signatureHeader: signature.header,
        signingSecret: "webhook-secret",
        store,
        now: occurredAt,
      }),
    ).rejects.toBeInstanceOf(ProviderWebhookVerificationError);

    await expect(
      verifyAndIngestProviderWebhook({
        orgId: orgA,
        providerId: providerA,
        providerKind: "mailgun",
        rawBody: raw,
        signatureHeader: signature.header,
        signingSecret: "webhook-secret",
        store,
        now: new Date(occurredAt.getTime() + 301_000),
      }),
    ).rejects.toBeInstanceOf(ProviderWebhookVerificationError);
  });

  it("is durably idempotent and tenant/provider scoped", async () => {
    const raw = mailgunPayload("duplicate-id", "delivered");
    const signature = signWebhookPayload({
      payload: raw,
      secret: "secret",
      timestamp: occurredAt,
    });
    const store = new InMemoryMailDeliveryEventStore([
      {
        id: "out-a",
        orgId: orgA,
        providerId: providerA,
        providerMessageId: "message-1",
      },
      {
        id: "out-b",
        orgId: orgB,
        providerId: providerB,
        providerMessageId: "message-1",
      },
    ]);
    const first = await verifyAndIngestProviderWebhook({
      orgId: orgA,
      providerId: providerA,
      providerKind: "mailgun",
      rawBody: raw,
      signatureHeader: signature.header,
      signingSecret: "secret",
      store,
      now: occurredAt,
    });
    const duplicate = await verifyAndIngestProviderWebhook({
      orgId: orgA,
      providerId: providerA,
      providerKind: "mailgun",
      rawBody: raw,
      signatureHeader: signature.header,
      signingSecret: "secret",
      store,
      now: occurredAt,
    });
    expect(first.event.outboundId).toBe("out-a");
    expect(duplicate.duplicate).toBe(true);
    expect(await store.listEvents({ orgId: orgB, outboundId: "out-b" })).toHaveLength(0);
  });
});

describe("normalized delivery events and suppression", () => {
  it("normalizes hard/soft bounces and complaint events", () => {
    expect(
      normalizeMailgunDeliveryEvent(
        JSON.parse(mailgunPayload("1", "failed", "temporary").toString()),
      ).type,
    ).toBe("soft_bounce");
    expect(
      normalizeMailgunDeliveryEvent(
        JSON.parse(mailgunPayload("2", "failed", "permanent").toString()),
      ).type,
    ).toBe("hard_bounce");
    expect(
      normalizeMailgunDeliveryEvent(JSON.parse(mailgunPayload("3", "complained").toString())).type,
    ).toBe("complaint");
  });

  it("suppresses only the affected organization and audits an admin clear", async () => {
    const store = new InMemoryMailDeliveryEventStore([], () => occurredAt);
    const event = normalizeMailgunDeliveryEvent(
      JSON.parse(mailgunPayload("hard-1", "failed", "permanent").toString()),
    );
    await store.ingestEvent({ orgId: orgA, providerId: providerA, event });

    const orgASuppressions = await store.findActiveSuppressions(orgA, ["USER@EXAMPLE.NET"]);
    expect(orgASuppressions).toHaveLength(1);
    expect(await store.findActiveSuppressions(orgB, ["user@example.net"])).toHaveLength(0);
    const suppression = orgASuppressions[0];
    if (suppression === undefined) throw new Error("Expected an active suppression.");

    const append = vi.fn().mockResolvedValue({ id: "audit-1", thisHash: "hash" });
    const cleared = await clearMailSuppressionWithAudit({
      store,
      auditSink: { append },
      orgId: orgA,
      actorId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      suppressionId: suppression.id,
      reason: "Recipient confirmed mailbox recovery.",
    });
    expect(cleared?.clearedAt).toEqual(occurredAt);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: orgA,
        verb: "mail.suppression.cleared",
        objectId: suppression.id,
      }),
    );
  });

  it("does not let an out-of-order event regress the latest delivery status", async () => {
    const store = new InMemoryMailDeliveryEventStore([
      {
        id: "out-a",
        orgId: orgA,
        providerId: providerA,
        providerMessageId: "message-1",
      },
    ]);
    const delivered = normalizeMailgunDeliveryEvent(
      JSON.parse(mailgunPayload("newer", "delivered").toString()),
    );
    const olderSoftBounce = {
      ...normalizeMailgunDeliveryEvent(
        JSON.parse(mailgunPayload("older", "failed", "temporary").toString()),
      ),
      occurredAt: new Date(occurredAt.getTime() - 60_000),
    };
    await store.ingestEvent({ orgId: orgA, providerId: providerA, event: delivered });
    await store.ingestEvent({ orgId: orgA, providerId: providerA, event: olderSoftBounce });

    expect(store.getLatestDeliveryStatus(orgA, "out-a")).toBe("delivered");
    expect(await store.findActiveSuppressions(orgA, ["user@example.net"])).toHaveLength(0);
  });

  it("suppresses complaints immediately and emits a threshold alert", async () => {
    const store = new InMemoryMailDeliveryEventStore();
    const emit = vi.fn();
    const monitor = new MailDeliveryAlertMonitor({
      store,
      emit,
      complaintThreshold: 1,
      now: () => occurredAt,
    });
    const event = normalizeMailgunDeliveryEvent(
      JSON.parse(mailgunPayload("complaint-1", "complained").toString()),
    );
    await store.ingestEvent({ orgId: orgA, providerId: providerA, event });
    await monitor.observe(orgA, event.type);

    expect(await store.findActiveSuppressions(orgA, ["user@example.net"])).toHaveLength(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: orgA, category: "complaint", count: 1 }),
    );
  });
});

function mailgunPayload(id: string, event: string, severity?: "temporary" | "permanent"): Buffer {
  return Buffer.from(
    JSON.stringify({
      signature: { timestamp: "unused", token: "unused", signature: "unused" },
      "event-data": {
        id,
        event,
        ...(severity === undefined ? {} : { severity }),
        recipient: "User@Example.NET",
        timestamp: occurredAt.getTime() / 1000,
        message: { headers: { "message-id": "message-1" } },
        "delivery-status": { code: severity === "temporary" ? 451 : 550, description: "safe" },
      },
    }),
  );
}
