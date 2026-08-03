// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HELIX_ACCESS_TOKEN_STORAGE_KEY } from "@/lib/auth";
import {
  createInboundWebhook,
  listOutboundWebhooks,
  listWebhookDeliveries,
  testInboundWebhook,
  updateOutboundWebhook,
} from "./api";
import type { InboundWebhook } from "./types";

describe("webhook API helpers", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    window.localStorage.setItem(HELIX_ACCESS_TOKEN_STORAGE_KEY, "webhook-admin-token");
    fetchMock = vi.fn<typeof fetch>((input) => {
      if (input === "/api/tools/webhook.outbound.list") {
        return Promise.resolve(
          Response.json({
            webhooks: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                orgId: "22222222-2222-4222-8222-222222222222",
                name: "Slack launch channel",
                url: "https://hooks.slack.test/launch",
                eventSubjects: ["activity.mail.received"],
                secretRef: null,
                headers: {},
                enabled: true,
                metadata: { format: "slack" },
                createdByActorId: null,
                createdAt: "2026-05-20T12:00:00.000Z",
                updatedAt: "2026-05-20T12:05:00.000Z",
              },
            ],
          }),
        );
      }
      if (input === "/api/tools/webhook.delivery.list") {
        return Promise.resolve(
          Response.json({
            deliveries: [
              {
                id: "44444444-4444-4444-8444-444444444444",
                orgId: "22222222-2222-4222-8222-222222222222",
                direction: "outbound",
                outboundWebhookId: "11111111-1111-4111-8111-111111111111",
                inboundWebhookId: null,
                eventSubject: "activity.mail.received",
                status: "delivered",
                attempt: 1,
                payload: { ok: true },
                payloadSha256: null,
                signature: null,
                requestHeaders: {},
                responseStatus: 200,
                responseHeaders: {},
                error: null,
                nextAttemptAt: null,
                deliveredAt: "2026-05-20T12:12:00.000Z",
                createdAt: "2026-05-20T12:11:00.000Z",
                updatedAt: "2026-05-20T12:12:00.000Z",
              },
            ],
          }),
        );
      }
      if (typeof input === "string" && input.startsWith("/webhooks/")) {
        return Promise.resolve(Response.json({ deliveryId: "delivery-1", ok: true }));
      }
      return Promise.resolve(Response.json({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("calls webhook tool endpoints with bearer auth and typed JSON payloads", async () => {
    await expect(listOutboundWebhooks()).resolves.toHaveLength(1);
    await updateOutboundWebhook({
      id: "11111111-1111-4111-8111-111111111111",
      enabled: false,
      secretRef: "inline:new-secret",
    });
    await createInboundWebhook({
      name: "GitHub deploy hook",
      slug: "github-deploy",
      source: "github",
      enabled: true,
      metadata: { action: { toolId: "chat.send" } },
      secretRef: "inline:test-secret",
    });
    await expect(
      listWebhookDeliveries({
        direction: "outbound",
        status: "delivered",
        webhookId: "11111111-1111-4111-8111-111111111111",
        createdAfter: "2026-05-20T12:00:00.000Z",
        createdBefore: "2026-05-20T13:00:00.000Z",
        limit: 50,
      }),
    ).resolves.toHaveLength(1);

    expect(fetchBody("/api/tools/webhook.outbound.update")).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      enabled: false,
      secretRef: "inline:new-secret",
    });
    expect(fetchBody("/api/tools/webhook.inbound.create")).toMatchObject({
      name: "GitHub deploy hook",
      slug: "github-deploy",
      source: "github",
      enabled: true,
      metadata: { action: { toolId: "chat.send" } },
      secretRef: "inline:test-secret",
    });
    expect(fetchBody("/api/tools/webhook.delivery.list")).toEqual({
      direction: "outbound",
      status: "delivered",
      /* `webhookId` is one field in the UI but two columns on the delivery row,
         so the direction decides which one it filters. Sent under the UI's own
         name the server ignored it and returned every endpoint's deliveries —
         a filter that looks applied and is not. */
      outboundWebhookId: "11111111-1111-4111-8111-111111111111",
      createdAfter: "2026-05-20T12:00:00.000Z",
      createdBefore: "2026-05-20T13:00:00.000Z",
      limit: 50,
    });
    expect(headersForCall("/api/tools/webhook.outbound.list").get("authorization")).toBe(
      "Bearer webhook-admin-token",
    );
  });

  it("posts inbound verification probes to the public webhook endpoint with source-specific signatures", async () => {
    const result = await testInboundWebhook(githubInboundWebhook());

    expect(result).toEqual({ deliveryId: "delivery-1", ok: true });
    const call = fetchMock.mock.calls.find(
      (candidate) => candidate[0] === "/webhooks/github-deploy",
    );
    expect(call?.[1]?.method).toBe("POST");
    const headers = new Headers(call?.[1]?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-github-event")).toBe("ping");
    expect(headers.get("x-github-delivery")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(headers.get("x-hub-signature-256")).toMatch(/^sha256=[0-9a-f]{64}$/u);
    const body = call?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error("Expected inbound verification body.");
    }
    expect(JSON.parse(body)).toMatchObject({
      zen: "Helix webhook verification",
      repository: { full_name: "helix/test" },
    });
  });

  it("posts verification probes for GitLab, Grafana, and Prometheus inbound sources", async () => {
    await testInboundWebhook(providerInboundWebhook("gitlab"));
    await testInboundWebhook(providerInboundWebhook("grafana"));
    await testInboundWebhook(providerInboundWebhook("prometheus"));

    const gitlabHeaders = new Headers(callForWebhook("gitlab-hook")?.[1]?.headers);
    expect(gitlabHeaders.get("x-gitlab-token")).toBe("test-secret");
    expect(gitlabHeaders.get("x-gitlab-event")).toBe("Push Hook");
    expect(gitlabHeaders.get("x-gitlab-event-uuid")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(jsonBodyForWebhook("gitlab-hook")).toMatchObject({
      object_kind: "push",
      project: { path_with_namespace: "helix/test" },
    });

    const grafanaHeaders = new Headers(callForWebhook("grafana-hook")?.[1]?.headers);
    expect(grafanaHeaders.get("x-grafana-alerting-signature")).toMatch(/^[0-9a-f]{64}$/u);
    expect(grafanaHeaders.get("x-grafana-alerting-timestamp")).toMatch(/^\d+$/u);
    expect(jsonBodyForWebhook("grafana-hook")).toMatchObject({
      status: "firing",
      groupLabels: { alertname: "HelixWebhookVerification" },
    });

    const prometheusHeaders = new Headers(callForWebhook("prometheus-hook")?.[1]?.headers);
    expect(prometheusHeaders.get("authorization")).toBe("Bearer test-secret");
    expect(jsonBodyForWebhook("prometheus-hook")).toMatchObject({
      version: "4",
      status: "firing",
      truncatedAlerts: 0,
    });
  });

  function fetchBody(url: string): unknown {
    const body = fetchMock.mock.calls.find((call) => call[0] === url)?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error(`Expected request body for ${url}.`);
    }
    return JSON.parse(body) as unknown;
  }

  function headersForCall(url: string): Headers {
    const init = fetchMock.mock.calls.find((call) => call[0] === url)?.[1];
    return new Headers(init?.headers);
  }

  function callForWebhook(slug: string): Parameters<typeof fetch> | undefined {
    return fetchMock.mock.calls.find((call) => call[0] === `/webhooks/${slug}`);
  }

  function jsonBodyForWebhook(slug: string): unknown {
    const body = callForWebhook(slug)?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error(`Expected verification body for ${slug}.`);
    }
    return JSON.parse(body) as unknown;
  }
});

function githubInboundWebhook(): InboundWebhook {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    orgId: "22222222-2222-4222-8222-222222222222",
    name: "GitHub deploy hook",
    slug: "github-deploy",
    source: "github",
    secretRef: "inline:test-secret",
    enabled: true,
    metadata: { action: { toolId: "chat.send" } },
    createdByActorId: null,
    lastReceivedAt: null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:05:00.000Z",
  };
}

function providerInboundWebhook(source: string): InboundWebhook {
  return {
    ...githubInboundWebhook(),
    name: `${source} hook`,
    slug: `${source}-hook`,
    source,
  };
}
