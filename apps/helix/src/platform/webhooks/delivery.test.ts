import { describe, expect, it } from "vitest";
import {
  deliverOutboundWebhook,
  verifyInboundWebhookPayload,
  type WebhookDeliveryStore,
  type WebhookHttpClient,
  type WebhookHttpResponse,
} from "./delivery.js";
import { signWebhookPayload, verifyWebhookSignature } from "./signatures.js";
import type {
  CreateWebhookDeliveryInput,
  OutboundWebhookRecord,
  UpdateWebhookDeliveryStatusInput,
  WebhookDeliveryRecord,
  WebhookSecretResolver,
} from "./store.js";

const orgId = "00000000-0000-4000-8000-000000000001";
const webhookId = "00000000-0000-4000-8000-000000000010";
const now = new Date("2026-05-20T12:00:00.000Z");

describe("webhook secret resolution", () => {
  it("keeps inline refs working for outbound signing and inbound verification", async () => {
    const store = new InMemoryDeliveryStore();
    const httpClient = new RecordingHttpClient([{ status: 204, headers: {}, body: "" }]);

    const delivery = await deliverOutboundWebhook({
      store,
      httpClient,
      now,
      webhook: outboundWebhook({ secretRef: "inline:inline-secret" }),
      event: { subject: "webhook.test", payload: { ok: true } },
    });

    expect(delivery?.status).toBe("delivered");
    const request = httpClient.requests[0];
    expect(request).toBeDefined();
    expect(
      verifyWebhookSignature({
        payload: request?.body ?? "",
        secret: "inline-secret",
        header: request?.headers["x-helix-signature"] ?? "",
        now,
      }),
    ).toBe(true);

    const signed = signWebhookPayload({
      payload: request?.body ?? "",
      secret: "inline-secret",
      timestamp: now,
    });
    await expect(
      verifyInboundWebhookPayload({
        payload: request?.body ?? "",
        secretRef: "inline:inline-secret",
        signatureHeader: signed.header,
        now,
      }),
    ).resolves.toBe(true);
  });

  it("fails closed for non-inline refs when no resolver is configured", async () => {
    const store = new InMemoryDeliveryStore();
    const httpClient = new RecordingHttpClient([{ status: 204, headers: {}, body: "" }]);

    await expect(
      deliverOutboundWebhook({
        store,
        httpClient,
        now,
        webhook: outboundWebhook({ secretRef: "vault:webhooks/outbound/test" }),
        event: { subject: "webhook.test", payload: { ok: true } },
      }),
    ).rejects.toThrow("Unable to resolve webhook secret ref");

    expect(httpClient.requests).toHaveLength(0);
    expect(store.deliveries).toHaveLength(0);

    const signedWithRawRef = signWebhookPayload({
      payload: "payload",
      secret: "vault:webhooks/outbound/test",
      timestamp: now,
    });
    await expect(
      verifyInboundWebhookPayload({
        payload: "payload",
        secretRef: "vault:webhooks/outbound/test",
        signatureHeader: signedWithRawRef.header,
        now,
      }),
    ).rejects.toThrow("Unable to resolve webhook secret ref");
  });

  it("uses a configured resolver for non-inline refs without treating the ref as the secret", async () => {
    const store = new InMemoryDeliveryStore();
    const httpClient = new RecordingHttpClient([{ status: 204, headers: {}, body: "" }]);
    const secretResolver = new MapSecretResolver({
      "vault:webhooks/outbound/test": "resolved-secret",
    });

    await deliverOutboundWebhook({
      store,
      httpClient,
      now,
      secretResolver,
      webhook: outboundWebhook({ secretRef: "vault:webhooks/outbound/test" }),
      event: { subject: "webhook.test", payload: { ok: true } },
    });

    const request = httpClient.requests[0];
    expect(secretResolver.refs).toEqual(["vault:webhooks/outbound/test"]);
    expect(
      verifyWebhookSignature({
        payload: request?.body ?? "",
        secret: "resolved-secret",
        header: request?.headers["x-helix-signature"] ?? "",
        now,
      }),
    ).toBe(true);
    expect(
      verifyWebhookSignature({
        payload: request?.body ?? "",
        secret: "vault:webhooks/outbound/test",
        header: request?.headers["x-helix-signature"] ?? "",
        now,
      }),
    ).toBe(false);

    const signedWithResolvedSecret = signWebhookPayload({
      payload: "payload",
      secret: "resolved-secret",
      timestamp: now,
    });
    await expect(
      verifyInboundWebhookPayload({
        payload: "payload",
        secretRef: "vault:webhooks/outbound/test",
        secretResolver,
        signatureHeader: signedWithResolvedSecret.header,
        now,
      }),
    ).resolves.toBe(true);
  });
});

describe("outbound webhook delivery policy", () => {
  it("rejects disabled outbound webhooks before creating a delivery", async () => {
    const store = new InMemoryDeliveryStore();
    const httpClient = new RecordingHttpClient([{ status: 204, headers: {}, body: "" }]);

    await expect(
      deliverOutboundWebhook({
        store,
        httpClient,
        now,
        webhook: outboundWebhook({ enabled: false }),
        event: { subject: "webhook.test", payload: { ok: true } },
      }),
    ).rejects.toThrow("Outbound webhook is disabled");

    expect(httpClient.requests).toHaveLength(0);
    expect(store.deliveries).toHaveLength(0);
  });

  it("blocks payload classifications disallowed by webhook metadata", async () => {
    const store = new InMemoryDeliveryStore();
    const httpClient = new RecordingHttpClient([{ status: 204, headers: {}, body: "" }]);

    await expect(
      deliverOutboundWebhook({
        store,
        httpClient,
        now,
        webhook: outboundWebhook({
          metadata: {
            classificationPolicy: {
              blockedClassifications: ["restricted"],
            },
          },
        }),
        event: {
          subject: "webhook.test",
          payload: { id: "doc-1", metadata: { classification: "restricted" } },
        },
      }),
    ).rejects.toThrow("Outbound webhook policy blocks restricted payloads");

    expect(httpClient.requests).toHaveLength(0);
    expect(store.deliveries).toHaveLength(0);
  });
});

class MapSecretResolver implements WebhookSecretResolver {
  readonly refs: string[] = [];

  constructor(private readonly secrets: Record<string, string>) {}

  resolveSecretRef(secretRef: string): string | null {
    this.refs.push(secretRef);
    return this.secrets[secretRef] ?? null;
  }
}

class RecordingHttpClient implements WebhookHttpClient {
  readonly requests: {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: string;
  }[] = [];

  constructor(private readonly responses: WebhookHttpResponse[]) {}

  async post(input: {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: string;
  }): Promise<WebhookHttpResponse> {
    this.requests.push(input);
    return this.responses.shift() ?? { status: 204, headers: {}, body: "" };
  }
}

class InMemoryDeliveryStore implements WebhookDeliveryStore {
  readonly deliveries: WebhookDeliveryRecord[] = [];

  async createDelivery(input: CreateWebhookDeliveryInput): Promise<WebhookDeliveryRecord> {
    const delivery: WebhookDeliveryRecord = {
      id: input.id ?? "00000000-0000-4000-8000-000000000099",
      orgId: input.orgId,
      direction: input.direction,
      outboundWebhookId: input.outboundWebhookId ?? null,
      inboundWebhookId: input.inboundWebhookId ?? null,
      eventSubject: input.eventSubject,
      status: input.status ?? "pending",
      attempt: input.attempt ?? 0,
      payload: input.payload,
      payloadSha256: input.payloadSha256 ?? null,
      signature: input.signature ?? null,
      requestHeaders: input.requestHeaders ?? {},
      responseStatus: input.responseStatus ?? null,
      responseHeaders: input.responseHeaders ?? {},
      error: input.error ?? null,
      nextAttemptAt: input.nextAttemptAt ?? null,
      deliveredAt: input.deliveredAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.deliveries.push(delivery);
    return delivery;
  }

  async updateDeliveryStatus(
    input: UpdateWebhookDeliveryStatusInput,
  ): Promise<WebhookDeliveryRecord | null> {
    const current = this.deliveries.find((delivery) => delivery.id === input.id);
    if (current === undefined) {
      return null;
    }
    const updated: WebhookDeliveryRecord = {
      ...current,
      status: input.status,
      attempt: input.attempt ?? current.attempt,
      signature: input.signature === undefined ? current.signature : input.signature,
      requestHeaders: input.requestHeaders ?? current.requestHeaders,
      responseStatus:
        input.responseStatus === undefined ? current.responseStatus : input.responseStatus,
      responseHeaders: input.responseHeaders ?? current.responseHeaders,
      error: input.error === undefined ? current.error : input.error,
      nextAttemptAt:
        input.nextAttemptAt === undefined ? current.nextAttemptAt : input.nextAttemptAt,
      deliveredAt: input.deliveredAt === undefined ? current.deliveredAt : input.deliveredAt,
      updatedAt: now,
    };
    this.deliveries[this.deliveries.indexOf(current)] = updated;
    return updated;
  }
}

function outboundWebhook(overrides: Partial<OutboundWebhookRecord>): OutboundWebhookRecord {
  return {
    id: webhookId,
    orgId,
    name: "Webhook",
    url: "https://example.test/webhook",
    eventSubjects: ["webhook.test"],
    secretRef: "inline:test-secret",
    headers: {},
    enabled: true,
    metadata: {},
    createdByActorId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
