import { createHmac } from "node:crypto";
import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerWebhookRoutes } from "./routes.js";
import type {
  CreateWebhookDeliveryInput,
  InboundWebhookRecord,
  PostgresWebhookStore,
  WebhookDeliveryRecord,
} from "./store.js";

const orgId = "00000000-0000-4000-8000-000000000001";
const inboundWebhookId = "00000000-0000-4000-8000-000000000010";
const now = new Date("2026-05-20T12:00:00.000Z");

describe("webhook routes", () => {
  it("verifies provider signatures against the raw inbound request body", async () => {
    const webhook = inboundWebhook({
      source: "github",
      secretRef: "inline:github-secret",
      slug: "github-deploy",
    });
    const store = new InMemoryWebhookRouteStore(webhook);
    const app = fastify();
    await registerWebhookRoutes(app, { store: store as unknown as PostgresWebhookStore });

    const payload = [
      "{",
      '  "ref": "refs/heads/main",',
      '  "repository": { "full_name": "helix/workspace" },',
      '  "commits": [{ "id": "abc" }]',
      "}",
    ].join("\n");
    const signature = createHmac("sha256", "github-secret").update(payload).digest("hex");

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github-deploy",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": `sha256=${signature}`,
      },
      payload,
    });

    expect(response.statusCode).toBe(202);
    expect(store.deliveries).toHaveLength(1);
    expect(store.deliveries[0]).toMatchObject({
      direction: "inbound",
      inboundWebhookId,
      eventSubject: "github.push",
      status: "delivered",
      signature: `sha256=${signature}`,
    });
    expect(store.lastReceivedAt).toBeInstanceOf(Date);
  });

  it("accepts GitLab source webhooks with token verification and provider event subjects", async () => {
    const webhook = inboundWebhook({
      source: "gitlab",
      secretRef: "inline:gitlab-secret",
      slug: "gitlab-deploy",
    });
    const store = new InMemoryWebhookRouteStore(webhook);
    const app = fastify();
    await registerWebhookRoutes(app, { store: store as unknown as PostgresWebhookStore });

    const payload = JSON.stringify({
      object_kind: "push",
      ref: "refs/heads/main",
      project: { path_with_namespace: "helix/workspace" },
      commits: [{ id: "abc" }],
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/gitlab-deploy",
      headers: {
        "content-type": "application/json",
        "x-gitlab-token": "gitlab-secret",
        "x-gitlab-event": "Push Hook",
        "x-gitlab-event-uuid": "event-123",
      },
      payload,
    });

    expect(response.statusCode).toBe(202);
    expect(store.deliveries[0]).toMatchObject({
      direction: "inbound",
      inboundWebhookId,
      eventSubject: "gitlab.Push Hook",
      status: "delivered",
      signature: null,
      payload: {
        sourceType: "gitlab",
        deliveryId: "event-123",
        projectPath: "helix/workspace",
        commitCount: 1,
      },
    });
  });
});

class InMemoryWebhookRouteStore {
  readonly deliveries: WebhookDeliveryRecord[] = [];
  lastReceivedAt: Date | null = null;

  constructor(private readonly webhook: InboundWebhookRecord) {}

  async getInboundBySlug(slug: string): Promise<InboundWebhookRecord | null> {
    return slug === this.webhook.slug ? this.webhook : null;
  }

  async createDelivery(input: CreateWebhookDeliveryInput): Promise<WebhookDeliveryRecord> {
    const delivery: WebhookDeliveryRecord = {
      id: "00000000-0000-4000-8000-000000000020",
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

  async markInboundReceived(_inboundWebhookId: string, receivedAt: Date): Promise<void> {
    this.lastReceivedAt = receivedAt;
  }
}

function inboundWebhook(overrides: Partial<InboundWebhookRecord> = {}): InboundWebhookRecord {
  return {
    id: inboundWebhookId,
    orgId,
    name: "GitHub deploy",
    slug: "github-deploy",
    source: "github",
    secretRef: "inline:github-secret",
    enabled: true,
    metadata: {},
    createdByActorId: null,
    lastReceivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
