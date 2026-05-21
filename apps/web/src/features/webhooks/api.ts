import { queryOptions } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/auth";
import type {
  DeliveryListInput,
  InboundWebhook,
  OutboundWebhook,
  WebhookDelivery,
  WebhookDirection,
  WebhookDeliveryStatus,
} from "./types";

export type WebhookDeliveryListInput = DeliveryListInput & {
  readonly webhookId?: string;
  readonly createdAfter?: string;
  readonly createdBefore?: string;
};

const jsonHeaders = {
  "content-type": "application/json",
} as const;

export const webhookQueryKeys = {
  outbound: ["webhooks", "outbound"] as const,
  inbound: ["webhooks", "inbound"] as const,
  deliveries: (filters: WebhookDeliveryListInput) =>
    [
      "webhooks",
      "deliveries",
      filters.direction ?? "all",
      filters.status ?? "all",
      filters.webhookId ?? "all",
      filters.createdAfter ?? "all",
      filters.createdBefore ?? "all",
      filters.limit ?? 100,
    ] as const,
};

export const defaultWebhookDeliveriesInput = {
  limit: 100,
} as const satisfies WebhookDeliveryListInput;

export function outboundWebhooksQueryOptions() {
  return queryOptions({
    queryKey: webhookQueryKeys.outbound,
    queryFn: listOutboundWebhooks,
    throwOnError: false,
  });
}

export function inboundWebhooksQueryOptions() {
  return queryOptions({
    queryKey: webhookQueryKeys.inbound,
    queryFn: listInboundWebhooks,
    throwOnError: false,
  });
}

export function webhookDeliveriesQueryOptions(
  input: WebhookDeliveryListInput = defaultWebhookDeliveriesInput,
) {
  return queryOptions({
    queryKey: webhookQueryKeys.deliveries(input),
    queryFn: () => listWebhookDeliveries(input),
    throwOnError: false,
  });
}

export async function listOutboundWebhooks(): Promise<readonly OutboundWebhook[]> {
  const output = await callTool<{ readonly webhooks: readonly OutboundWebhook[] }>(
    "webhook.outbound.list",
    {},
  );
  return output.webhooks;
}

export async function createOutboundWebhook(input: {
  readonly name: string;
  readonly url: string;
  readonly eventSubjects: readonly string[];
  readonly headers: Record<string, string>;
  readonly enabled: boolean;
  readonly metadata: Record<string, unknown>;
  readonly secretRef?: string;
}): Promise<OutboundWebhook> {
  return callTool("webhook.outbound.create", input);
}

export async function updateOutboundWebhook(input: {
  readonly id: string;
  readonly name?: string;
  readonly url?: string;
  readonly eventSubjects?: readonly string[];
  readonly headers?: Record<string, string>;
  readonly enabled?: boolean;
  readonly metadata?: Record<string, unknown>;
  readonly secretRef?: string;
}): Promise<OutboundWebhook> {
  return callTool("webhook.outbound.update", input);
}

export async function deleteOutboundWebhook(id: string): Promise<{ readonly deleted: boolean }> {
  return callTool("webhook.outbound.delete", { id });
}

export async function testOutboundWebhook(
  id: string,
): Promise<{ readonly delivery: WebhookDelivery | null }> {
  return callTool("webhook.outbound.test", {
    id,
    subject: "webhook.test",
    payload: {
      ok: true,
      source: "helix-admin-ui",
      sentAt: new Date().toISOString(),
    },
  });
}

export async function listInboundWebhooks(): Promise<readonly InboundWebhook[]> {
  const output = await callTool<{ readonly webhooks: readonly InboundWebhook[] }>(
    "webhook.inbound.list",
    {},
  );
  return output.webhooks;
}

export async function createInboundWebhook(input: {
  readonly name: string;
  readonly slug: string;
  readonly source: string;
  readonly enabled: boolean;
  readonly metadata: Record<string, unknown>;
  readonly secretRef?: string;
}): Promise<InboundWebhook> {
  return callTool("webhook.inbound.create", input);
}

export async function updateInboundWebhook(input: {
  readonly id: string;
  readonly name?: string;
  readonly slug?: string;
  readonly source?: string;
  readonly enabled?: boolean;
  readonly metadata?: Record<string, unknown>;
  readonly secretRef?: string;
}): Promise<InboundWebhook> {
  return callTool("webhook.inbound.update", input);
}

export async function deleteInboundWebhook(id: string): Promise<{ readonly deleted: boolean }> {
  return callTool("webhook.inbound.delete", { id });
}

export async function rotateInboundSecret(
  id: string,
): Promise<{ readonly webhook: InboundWebhook; readonly secretRef: string }> {
  return callTool("webhook.inbound.rotate-secret", { id });
}

export async function listWebhookDeliveries(
  input: WebhookDeliveryListInput,
): Promise<readonly WebhookDelivery[]> {
  const output = await callTool<{ readonly deliveries: readonly WebhookDelivery[] }>(
    "webhook.delivery.list",
    input,
  );
  return output.deliveries;
}

export async function testInboundWebhook(
  webhook: InboundWebhook,
): Promise<{ readonly deliveryId?: string; readonly ok: boolean }> {
  const payload = inboundTestPayload(webhook.source);
  const body = JSON.stringify(payload);
  const secret = secretValue(webhook.secretRef);
  const headers = await inboundTestHeaders(webhook.source, secret, body);
  const response = await fetch(`/webhooks/${encodeURIComponent(webhook.slug)}`, {
    method: "POST",
    headers,
    body,
  });
  const output = (await response.json().catch(() => ({}))) as {
    readonly deliveryId?: string;
    readonly ok?: boolean;
    readonly error?: string;
  };
  if (!response.ok) {
    throw new Error(output.error ?? `Inbound test failed with ${String(response.status)}`);
  }
  return { deliveryId: output.deliveryId, ok: output.ok ?? true };
}

export function generateInlineSecretRef(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `inline:${base64Url(bytes)}`;
}

async function callTool<Output>(toolId: string, input: unknown): Promise<Output> {
  const response = await authenticatedFetch(`/api/tools/${encodeURIComponent(toolId)}`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  const output = (await response.json().catch(() => ({}))) as { readonly error?: string };
  if (!response.ok) {
    throw new Error(output.error ?? `Tool ${toolId} failed with ${String(response.status)}`);
  }
  return output as Output;
}

async function inboundTestHeaders(
  source: string,
  secret: string,
  body: string,
): Promise<Record<string, string>> {
  if (source === "github") {
    return {
      ...jsonHeaders,
      "x-github-event": "ping",
      "x-github-delivery": crypto.randomUUID(),
      "x-hub-signature-256": `sha256=${await hmacSha256Hex(secret, body)}`,
    };
  }
  if (source === "linear") {
    return {
      ...jsonHeaders,
      "linear-signature": await hmacSha256Hex(secret, body),
    };
  }
  if (source === "gitlab") {
    return {
      ...jsonHeaders,
      "x-gitlab-token": secret,
      "x-gitlab-event": "Push Hook",
      "x-gitlab-event-uuid": crypto.randomUUID(),
    };
  }
  if (source === "grafana") {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return {
      ...jsonHeaders,
      "x-grafana-alerting-signature": await hmacSha256Hex(secret, `${timestamp}:${body}`),
      "x-grafana-alerting-timestamp": timestamp,
    };
  }
  if (source === "prometheus") {
    return {
      ...jsonHeaders,
      authorization: `Bearer ${secret}`,
    };
  }
  if (source === "stripe") {
    const timestamp = Math.floor(Date.now() / 1000);
    return {
      ...jsonHeaders,
      "stripe-signature": `t=${String(timestamp)},v1=${await hmacSha256Hex(secret, `${String(timestamp)}.${body}`)}`,
    };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  return {
    ...jsonHeaders,
    "x-helix-event": "inbound.generic.test",
    "x-helix-signature": `t=${String(timestamp)},v1=${await hmacSha256Hex(secret, `${String(timestamp)}.${body}`)}`,
  };
}

function inboundTestPayload(source: string): Record<string, unknown> {
  if (source === "github") {
    return {
      zen: "Helix webhook verification",
      hook_id: 120,
      repository: { full_name: "helix/test" },
    };
  }
  if (source === "linear") {
    return {
      type: "Issue",
      action: "create",
      organizationId: "helix",
      webhookId: "helix-admin-ui",
      data: { title: "Webhook verification" },
    };
  }
  if (source === "gitlab") {
    return {
      object_kind: "push",
      event_name: "push",
      ref: "refs/heads/main",
      project: { path_with_namespace: "helix/test" },
      commits: [{ id: "helix-test" }],
    };
  }
  if (source === "grafana") {
    return {
      receiver: "helix-admin-ui",
      status: "firing",
      alerts: [{ status: "firing", labels: { alertname: "HelixWebhookVerification" } }],
      groupLabels: { alertname: "HelixWebhookVerification" },
      commonLabels: { severity: "test" },
      title: "[FIRING] HelixWebhookVerification",
      message: "Webhook verification",
    };
  }
  if (source === "prometheus") {
    return {
      version: "4",
      receiver: "helix-admin-ui",
      status: "firing",
      alerts: [{ status: "firing", labels: { alertname: "HelixWebhookVerification" } }],
      groupLabels: { alertname: "HelixWebhookVerification" },
      commonLabels: { severity: "test" },
      groupKey: '{}:{alertname="HelixWebhookVerification"}',
      externalURL: "https://alertmanager.localhost",
      truncatedAlerts: 0,
    };
  }
  if (source === "stripe") {
    return {
      id: "evt_helix_test",
      type: "helix.webhook_test",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: { object: { id: "obj_helix_test" } },
    };
  }
  return {
    ok: true,
    source: "helix-admin-ui",
    sentAt: new Date().toISOString(),
  };
}

function secretValue(secretRef: string | null): string {
  if (secretRef?.startsWith("inline:") === true) {
    return secretRef.slice("inline:".length);
  }
  return secretRef ?? "";
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export const webhookDirections: readonly WebhookDirection[] = ["outbound", "inbound"];

export const webhookDeliveryStatuses: readonly WebhookDeliveryStatus[] = [
  "pending",
  "in_progress",
  "delivered",
  "failed",
  "abandoned",
];
