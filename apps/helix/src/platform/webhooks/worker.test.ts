import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import { OutboundWebhookWorker, type OutboundWebhookWorkerStore } from "./worker.js";
import { registerWebhookTools, type WebhookToolStore } from "./tools.js";
import type {
  Actor,
  EventBus,
  EventEnvelope,
  JsonValue,
  TraceContext,
  Unsubscribe,
} from "@helix/sdk-types";
import type {
  CreateInboundWebhookInput,
  CreateOutboundWebhookInput,
  CreateWebhookDeliveryInput,
  InboundWebhookPatch,
  InboundWebhookRecord,
  OutboundWebhookPatch,
  OutboundWebhookRecord,
  UpdateWebhookDeliveryStatusInput,
  WebhookDeliveryRecord,
} from "./store.js";
import type { WebhookDeliveryStatus, WebhookDirection } from "./types.js";
import type { WebhookHttpClient, WebhookHttpResponse } from "./delivery.js";

const orgId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const outboundWebhookId = "00000000-0000-4000-8000-000000000010";

describe("OutboundWebhookWorker", () => {
  it("dispatches an event to enabled outbound webhooks matching the subject", async () => {
    const store = new InMemoryWebhookStore([
      outboundWebhook({ id: outboundWebhookId, eventSubjects: ["ticket.*"] }),
      outboundWebhook({
        id: "00000000-0000-4000-8000-000000000011",
        eventSubjects: ["ticket.created"],
        enabled: false,
      }),
      outboundWebhook({
        id: "00000000-0000-4000-8000-000000000012",
        eventSubjects: ["invoice.created"],
      }),
    ]);
    const httpClient = new RecordingHttpClient([
      { status: 204, headers: { ok: "true" }, body: "" },
    ]);
    const worker = new OutboundWebhookWorker({
      store,
      events: new NoopEventBus(),
      httpClient,
    });

    await expect(
      worker.handle({
        subject: "ticket.created",
        payload: { id: "T-1" },
        trace: {
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          tracestate: "vendor=value",
        },
        occurredAt: "2026-05-20T12:00:00.000Z",
      }),
    ).resolves.toEqual({ attempted: 1, delivered: 1, failed: 0 });

    expect(httpClient.requests).toHaveLength(1);
    expect(httpClient.requests[0]?.url).toBe("https://example.test/webhook");
    expect(httpClient.requests[0]?.headers["x-helix-event"]).toBe("ticket.created");
    expect(httpClient.requests[0]?.headers["x-helix-delivery"]).toMatch(/[0-9a-f-]{36}/u);
    expect(httpClient.requests[0]?.headers["x-helix-timestamp"]).toMatch(/^\d+$/u);
    expect(httpClient.requests[0]?.headers.traceparent).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );
    expect(httpClient.requests[0]?.headers.tracestate).toBe("vendor=value");
    expect(store.deliveries).toHaveLength(1);
    expect(store.deliveries[0]?.status).toBe("delivered");
    expect(store.deliveries[0]?.attempt).toBe(1);
    expect(store.deliveries[0]?.requestHeaders.traceparent).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );
  });

  it("does not dispatch events blocked by outbound classification policy", async () => {
    const store = new InMemoryWebhookStore([
      outboundWebhook({
        id: outboundWebhookId,
        eventSubjects: ["ticket.*"],
        metadata: {
          classificationPolicy: {
            blockedClassifications: ["restricted"],
          },
        },
      }),
    ]);
    const httpClient = new RecordingHttpClient([
      { status: 204, headers: { ok: "true" }, body: "" },
    ]);
    const worker = new OutboundWebhookWorker({
      store,
      events: new NoopEventBus(),
      httpClient,
    });

    await expect(
      worker.handle({
        subject: "ticket.created",
        payload: { id: "T-1", classification: "restricted" },
        occurredAt: "2026-05-20T12:00:00.000Z",
      }),
    ).resolves.toEqual({ attempted: 1, delivered: 0, failed: 1 });

    expect(httpClient.requests).toHaveLength(0);
    expect(store.deliveries).toHaveLength(0);
  });

  it("claims due failed deliveries and retries them", async () => {
    const now = new Date("2026-05-20T12:00:00.000Z");
    const store = new InMemoryWebhookStore([
      outboundWebhook({ id: outboundWebhookId, eventSubjects: ["ticket.created"] }),
    ]);
    const httpClient = new RecordingHttpClient([
      { status: 500, headers: {}, body: "temporary failure" },
      { status: 204, headers: {}, body: "" },
    ]);
    const worker = new OutboundWebhookWorker({
      store,
      events: new NoopEventBus(),
      httpClient,
      retryPolicy: { maxAttempts: 3, delaysMs: [1_000] },
    });

    await worker.handle({
      subject: "ticket.created",
      payload: { id: "T-1" },
      trace: {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
      },
      occurredAt: now.toISOString(),
    });

    expect(store.deliveries[0]?.status).toBe("failed");
    const dueAt = store.deliveries[0]?.nextAttemptAt;
    expect(dueAt).toBeInstanceOf(Date);
    if (dueAt === undefined || dueAt === null) {
      throw new Error("expected failed delivery to have a retry time");
    }

    await expect(worker.drainRetries(dueAt)).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
    });

    expect(httpClient.requests).toHaveLength(2);
    expect(httpClient.requests[0]?.headers.traceparent).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );
    expect(httpClient.requests[1]?.headers.traceparent).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );
    expect(store.deliveries[0]?.status).toBe("delivered");
    expect(store.deliveries[0]?.attempt).toBe(2);
  });

  it("abandons claimed retries blocked by updated outbound classification policy", async () => {
    const now = new Date("2026-05-20T12:00:00.000Z");
    const store = new InMemoryWebhookStore([
      outboundWebhook({
        id: outboundWebhookId,
        eventSubjects: ["ticket.created"],
        metadata: {
          classificationPolicy: {
            blockedClassifications: ["restricted"],
          },
        },
      }),
    ]);
    await store.createDelivery({
      id: "00000000-0000-4000-8000-000000000098",
      orgId,
      direction: "outbound",
      outboundWebhookId,
      eventSubject: "ticket.created",
      status: "failed",
      attempt: 1,
      payload: {
        id: "00000000-0000-4000-8000-000000000098",
        subject: "ticket.created",
        occurredAt: "2026-05-20T11:00:00.000Z",
        data: { id: "T-1", metadata: { classification: "restricted" } },
      },
      nextAttemptAt: now,
    });
    const httpClient = new RecordingHttpClient([{ status: 204, headers: {}, body: "" }]);
    const worker = new OutboundWebhookWorker({
      store,
      events: new NoopEventBus(),
      httpClient,
    });

    await expect(worker.drainRetries(now)).resolves.toEqual({
      attempted: 1,
      delivered: 0,
      failed: 1,
    });

    expect(httpClient.requests).toHaveLength(0);
    expect(store.deliveries[0]?.status).toBe("abandoned");
    expect(store.deliveries[0]?.error).toContain(
      "Outbound webhook policy blocks restricted payloads",
    );
  });

  it("replays a failed outbound delivery through webhook.outbound.replay", async () => {
    const store = new InMemoryWebhookStore([
      outboundWebhook({ id: outboundWebhookId, eventSubjects: ["ticket.created"] }),
    ]);
    await store.createDelivery({
      id: "00000000-0000-4000-8000-000000000099",
      orgId,
      direction: "outbound",
      outboundWebhookId,
      eventSubject: "ticket.created",
      status: "failed",
      attempt: 1,
      payload: {
        id: "00000000-0000-4000-8000-000000000099",
        subject: "ticket.created",
        occurredAt: "2026-05-20T11:00:00.000Z",
        data: { id: "T-1" },
      },
      nextAttemptAt: new Date("2026-05-20T11:01:00.000Z"),
    });
    const httpClient = new RecordingHttpClient([{ status: 204, headers: {}, body: "" }]);
    const registry = createToolRegistry();
    registerWebhookTools(registry, { store, httpClient });

    const result = await registry.invoke(
      "webhook.outbound.replay",
      { deliveryId: "00000000-0000-4000-8000-000000000099" },
      { actor: adminActor() },
    );

    expect(result.ok).toBe(true);
    expect(httpClient.requests).toHaveLength(1);
    expect(JSON.parse(httpClient.requests[0]?.body ?? "{}")).toMatchObject({
      subject: "ticket.created",
      occurredAt: "2026-05-20T11:00:00.000Z",
      data: { id: "T-1" },
    });
    expect(store.deliveries).toHaveLength(2);
    expect(store.deliveries[1]?.id).not.toBe("00000000-0000-4000-8000-000000000099");
    expect(store.deliveries[1]?.status).toBe("delivered");
  });

  it("blocks replay when webhook metadata disallows the original payload classification", async () => {
    const store = new InMemoryWebhookStore([
      outboundWebhook({
        id: outboundWebhookId,
        eventSubjects: ["ticket.created"],
        metadata: {
          classificationPolicy: {
            blockedClassifications: ["restricted"],
          },
        },
      }),
    ]);
    await store.createDelivery({
      id: "00000000-0000-4000-8000-000000000097",
      orgId,
      direction: "outbound",
      outboundWebhookId,
      eventSubject: "ticket.created",
      status: "failed",
      attempt: 1,
      payload: {
        id: "00000000-0000-4000-8000-000000000097",
        subject: "ticket.created",
        occurredAt: "2026-05-20T11:00:00.000Z",
        data: { id: "T-1", classification: "restricted" },
      },
      nextAttemptAt: new Date("2026-05-20T11:01:00.000Z"),
    });
    const httpClient = new RecordingHttpClient([{ status: 204, headers: {}, body: "" }]);
    const registry = createToolRegistry();
    registerWebhookTools(registry, { store, httpClient });

    const result = await registry.invoke(
      "webhook.outbound.replay",
      { deliveryId: "00000000-0000-4000-8000-000000000097" },
      { actor: adminActor() },
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected webhook replay to be blocked.");
    }
    expect(result.statusCode).toBe(500);
    expect(result.error).toContain("Outbound webhook policy blocks restricted payloads");
    expect(httpClient.requests).toHaveLength(0);
    expect(store.deliveries).toHaveLength(1);
  });
});

class InMemoryWebhookStore implements OutboundWebhookWorkerStore, WebhookToolStore {
  readonly deliveries: WebhookDeliveryRecord[] = [];
  private readonly outbounds = new Map<string, OutboundWebhookRecord>();

  constructor(outbounds: readonly OutboundWebhookRecord[]) {
    for (const webhook of outbounds) {
      this.outbounds.set(webhook.id, webhook);
    }
  }

  async createOutbound(input: CreateOutboundWebhookInput): Promise<OutboundWebhookRecord> {
    const webhook = outboundWebhook({
      id: nextUuid(),
      orgId: input.orgId,
      name: input.name,
      url: input.url,
      eventSubjects: input.eventSubjects,
      secretRef: input.secretRef ?? null,
      headers: input.headers ?? {},
      enabled: input.enabled ?? true,
      metadata: input.metadata ?? {},
      createdByActorId: input.createdByActorId ?? null,
    });
    this.outbounds.set(webhook.id, webhook);
    return webhook;
  }

  async updateOutbound(input: {
    readonly orgId: string;
    readonly id: string;
    readonly patch: OutboundWebhookPatch;
  }): Promise<OutboundWebhookRecord | null> {
    const current = await this.getOutbound(input.orgId, input.id);
    if (current === null) {
      return null;
    }
    const updated: OutboundWebhookRecord = {
      ...current,
      name: input.patch.name ?? current.name,
      url: input.patch.url ?? current.url,
      eventSubjects: input.patch.eventSubjects ?? current.eventSubjects,
      secretRef: input.patch.secretRef === undefined ? current.secretRef : input.patch.secretRef,
      headers: input.patch.headers ?? current.headers,
      enabled: input.patch.enabled ?? current.enabled,
      metadata: input.patch.metadata ?? current.metadata,
      updatedAt: new Date("2026-05-20T12:00:00.000Z"),
    };
    this.outbounds.set(input.id, updated);
    return updated;
  }

  async deleteOutbound(orgIdValue: string, id: string): Promise<boolean> {
    const current = await this.getOutbound(orgIdValue, id);
    return current === null ? false : this.outbounds.delete(id);
  }

  async getOutbound(orgIdValue: string, id: string): Promise<OutboundWebhookRecord | null> {
    const webhook = this.outbounds.get(id);
    return webhook?.orgId === orgIdValue ? webhook : null;
  }

  async listOutbound(orgIdValue: string): Promise<readonly OutboundWebhookRecord[]> {
    return [...this.outbounds.values()].filter((webhook) => webhook.orgId === orgIdValue);
  }

  async listEnabledOutbound(): Promise<readonly OutboundWebhookRecord[]> {
    return [...this.outbounds.values()].filter((webhook) => webhook.enabled);
  }

  async createInbound(input: CreateInboundWebhookInput): Promise<InboundWebhookRecord> {
    return inboundWebhook({
      id: nextUuid(),
      orgId: input.orgId,
      name: input.name,
      slug: input.slug,
      source: input.source,
      secretRef: input.secretRef ?? null,
      enabled: input.enabled ?? true,
      metadata: input.metadata ?? {},
      createdByActorId: input.createdByActorId ?? null,
    });
  }

  async updateInbound(input: {
    readonly orgId: string;
    readonly id: string;
    readonly patch: InboundWebhookPatch;
  }): Promise<InboundWebhookRecord | null> {
    void input;
    return null;
  }

  async deleteInbound(orgIdValue: string, id: string): Promise<boolean> {
    void orgIdValue;
    void id;
    return false;
  }

  async rotateInboundSecret(
    orgIdValue: string,
    id: string,
  ): Promise<{ readonly webhook: InboundWebhookRecord; readonly secretRef: string } | null> {
    void orgIdValue;
    void id;
    return null;
  }

  async listInbound(orgIdValue: string): Promise<readonly InboundWebhookRecord[]> {
    void orgIdValue;
    return [];
  }

  async createDelivery(input: CreateWebhookDeliveryInput): Promise<WebhookDeliveryRecord> {
    const now = new Date("2026-05-20T12:00:00.000Z");
    const delivery: WebhookDeliveryRecord = {
      id: input.id ?? nextUuid(),
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
    const index = this.deliveries.findIndex((delivery) => delivery.id === input.id);
    const current = this.deliveries[index];
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
      updatedAt: new Date("2026-05-20T12:00:00.000Z"),
    };
    this.deliveries[index] = updated;
    return updated;
  }

  async getDelivery(orgIdValue: string, id: string): Promise<WebhookDeliveryRecord | null> {
    return (
      this.deliveries.find((delivery) => delivery.orgId === orgIdValue && delivery.id === id) ??
      null
    );
  }

  async listDeliveries(input: {
    readonly orgId: string;
    readonly direction?: WebhookDirection | undefined;
    readonly status?: WebhookDeliveryStatus | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly WebhookDeliveryRecord[]> {
    return this.deliveries
      .filter((delivery) => delivery.orgId === input.orgId)
      .filter((delivery) => input.direction === undefined || delivery.direction === input.direction)
      .filter((delivery) => input.status === undefined || delivery.status === input.status)
      .slice(0, input.limit ?? 100);
  }

  async claimDueOutboundDeliveries(
    input: {
      readonly limit?: number | undefined;
      readonly now?: Date | undefined;
    } = {},
  ): Promise<readonly WebhookDeliveryRecord[]> {
    const now = input.now ?? new Date();
    const due = this.deliveries.filter(
      (delivery) =>
        delivery.direction === "outbound" &&
        (delivery.status === "pending" || delivery.status === "failed") &&
        delivery.nextAttemptAt !== null &&
        delivery.nextAttemptAt.getTime() <= now.getTime(),
    );
    const claimed: WebhookDeliveryRecord[] = [];
    for (const delivery of due.slice(0, input.limit ?? 100)) {
      const updated = await this.updateDeliveryStatus({
        id: delivery.id,
        status: "in_progress",
        attempt: delivery.attempt + 1,
        responseStatus: null,
        responseHeaders: {},
        error: null,
        nextAttemptAt: null,
      });
      if (updated !== null) {
        claimed.push(updated);
      }
    }
    return claimed;
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

class NoopEventBus implements EventBus {
  async publish(subject: string, payload: JsonValue, trace?: TraceContext): Promise<void> {
    void subject;
    void payload;
    void trace;
  }

  async subscribe<Payload extends JsonValue>(
    subject: string,
    handler: (event: EventEnvelope<Payload>) => Promise<void>,
  ): Promise<Unsubscribe> {
    void subject;
    void handler;
    return () => {};
  }
}

function outboundWebhook(overrides: Partial<OutboundWebhookRecord>): OutboundWebhookRecord {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    orgId,
    name: "Webhook",
    url: "https://example.test/webhook",
    eventSubjects: ["ticket.created"],
    secretRef: "inline:test-secret",
    headers: {},
    enabled: true,
    metadata: {},
    createdByActorId: actorId,
    createdAt: new Date("2026-05-20T10:00:00.000Z"),
    updatedAt: new Date("2026-05-20T10:00:00.000Z"),
    ...overrides,
  };
}

function inboundWebhook(overrides: Partial<InboundWebhookRecord>): InboundWebhookRecord {
  return {
    id: "00000000-0000-4000-8000-000000000020",
    orgId,
    name: "Inbound",
    slug: "inbound",
    source: "generic",
    secretRef: "inline:test-secret",
    enabled: true,
    metadata: {},
    createdByActorId: actorId,
    lastReceivedAt: null,
    createdAt: new Date("2026-05-20T10:00:00.000Z"),
    updatedAt: new Date("2026-05-20T10:00:00.000Z"),
    ...overrides,
  };
}

function adminActor(): Actor {
  return {
    id: actorId,
    orgId,
    type: "user",
    displayName: "Admin",
    scopes: ["admin.webhooks"],
  };
}

let uuidCounter = 200;

function nextUuid(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}
