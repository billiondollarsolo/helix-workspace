import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { verifyInboundWebhookPayload } from "./delivery.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import {
  resolveWebhookSecret,
  type InboundWebhookRecord,
  type PostgresWebhookStore,
  type WebhookSecretResolver,
} from "./store.js";
import {
  githubWebhookSource,
  gitlabWebhookSource,
  grafanaWebhookSource,
  linearWebhookSource,
  parseJsonPayload,
  prometheusWebhookSource,
  stripeWebhookSource,
  type InboundSourceAdapter,
  type ParseSourceWebhookOptions,
  type WebhookHeaders,
} from "./sources/index.js";
import { z } from "zod3";

const paramsSchema = z.object({
  slug: z.string().min(1),
});

const rawWebhookBodies = new WeakMap<object, Buffer>();
const providerSources = new Map<string, InboundSourceAdapter<{ readonly event: string }>>([
  ["github", githubWebhookSource],
  ["gitlab", gitlabWebhookSource],
  ["grafana", grafanaWebhookSource],
  ["linear", linearWebhookSource],
  ["alertmanager", prometheusWebhookSource],
  ["prometheus", prometheusWebhookSource],
  ["stripe", stripeWebhookSource],
]);
const providerSignatureHeaders: Readonly<Record<string, string>> = {
  github: "x-hub-signature-256",
  linear: "linear-signature",
  stripe: "stripe-signature",
};

export interface RegisterWebhookRoutesOptions {
  readonly store: PostgresWebhookStore;
  readonly secretResolver?: WebhookSecretResolver;
  readonly tools?: RuntimeToolRegistry;
}

export async function registerWebhookRoutes(
  app: FastifyInstance,
  options: RegisterWebhookRoutesOptions,
): Promise<void> {
  app.addHook("preParsing", (request, _reply, payload, done) => {
    if (!request.url.startsWith("/webhooks/")) {
      done(null, payload);
      return;
    }

    void readPayload(payload)
      .then((rawBody) => {
        rawWebhookBodies.set(request, rawBody);
        const replay = Readable.from(rawBody);
        (replay as Readable & { receivedEncodedLength?: number }).receivedEncodedLength =
          rawBody.length;
        done(null, replay);
      })
      .catch((error: unknown) => {
        done(error instanceof Error ? error : new Error("Unable to read webhook body"));
      });
  });

  app.post("/webhooks/:slug", async (request, reply) => {
    const params = paramsSchema.parse(request.params);
    const webhook = await options.store.getInboundBySlug(params.slug);
    if (webhook === null) {
      return reply.code(404).send({ error: `Unknown inbound webhook: ${params.slug}` });
    }

    const payloadBuffer = rawWebhookBodies.get(request) ?? bodyToBuffer(request.body);
    const verificationHeaders = allHeaders(request.headers);
    const headers = compactHeaders(request.headers);
    const verified = await verifyAndParseInboundWebhook({
      webhook,
      payload: payloadBuffer,
      headers: verificationHeaders,
      ...(options.secretResolver === undefined ? {} : { secretResolver: options.secretResolver }),
    });
    const receivedAt = new Date();
    const routed =
      verified.accepted && options.tools !== undefined
        ? await routeInboundWebhookAction({
            tools: options.tools,
            webhook,
            parsedPayload: verified.parsedPayload,
            eventSubject: verified.eventSubject,
          })
        : { ok: true as const };
    const accepted = verified.accepted && routed.ok;
    const failureError = routed.ok ? verified.error : routed.error;
    const delivery = await options.store.createDelivery({
      orgId: webhook.orgId,
      direction: "inbound",
      inboundWebhookId: webhook.id,
      eventSubject: verified.eventSubject,
      status: accepted ? "delivered" : "failed",
      payload: verified.parsedPayload,
      signature: verified.signatureHeader ?? null,
      requestHeaders: headers,
      error: accepted ? null : failureError,
      deliveredAt: accepted ? receivedAt : null,
    });
    if (accepted) {
      await options.store.markInboundReceived(webhook.id, receivedAt);
      return reply.code(202).send({ ok: true, deliveryId: delivery.id });
    }
    return reply.code(verified.accepted ? 422 : 401).send({
      ok: false,
      deliveryId: delivery.id,
      error: failureError,
    });
  });
}

async function readPayload(payload: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of payload as AsyncIterable<Buffer | string | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function verifyAndParseInboundWebhook(input: {
  readonly webhook: InboundWebhookRecord;
  readonly payload: Buffer;
  readonly headers: WebhookHeaders;
  readonly secretResolver?: WebhookSecretResolver;
}): Promise<{
  readonly accepted: boolean;
  readonly eventSubject: string;
  readonly parsedPayload: unknown;
  readonly signatureHeader?: string;
  readonly error: string;
}> {
  const { webhook, payload, headers } = input;
  try {
    const providerSource = providerSources.get(webhook.source);
    if (providerSource !== undefined) {
      const secret = await resolveWebhookSecret(webhook.secretRef, input.secretResolver);
      const signatureHeaderName = providerSignatureHeaders[webhook.source];
      const signatureHeader =
        signatureHeaderName === undefined ? undefined : firstHeader(headers[signatureHeaderName]);
      const accepted = providerSource.verify({ payload, secret, headers });
      if (!accepted) {
        return {
          accepted: false,
          eventSubject: `${webhook.source}.rejected`,
          parsedPayload: safeParseJson(payload),
          ...(signatureHeader === undefined ? {} : { signatureHeader }),
          error: `Invalid ${formatSourceName(webhook.source)} webhook signature`,
        };
      }
      const parsed = providerSource.parse({ payload, headers } satisfies ParseSourceWebhookOptions);
      return {
        accepted: true,
        eventSubject: `${webhook.source}.${parsed.event}`,
        parsedPayload: parsed,
        ...(signatureHeader === undefined ? {} : { signatureHeader }),
        error: "",
      };
    }

    const signatureHeader = firstHeader(headers["x-helix-signature"]);
    const accepted = await verifyInboundWebhookPayload({
      payload,
      secretRef: webhook.secretRef,
      ...(input.secretResolver === undefined ? {} : { secretResolver: input.secretResolver }),
      signatureHeader,
    });
    return {
      accepted,
      eventSubject: firstHeader(headers["x-helix-event"]) ?? "inbound.generic",
      parsedPayload: safeParseJson(payload),
      ...(signatureHeader === undefined ? {} : { signatureHeader }),
      error: accepted ? "" : "Invalid webhook signature",
    };
  } catch (error) {
    return {
      accepted: false,
      eventSubject: `${webhook.source}.parse_failed`,
      parsedPayload: safeParseJson(payload),
      error: error instanceof Error ? error.message : "Webhook parsing failed",
    };
  }
}

function formatSourceName(source: string): string {
  return source.charAt(0).toUpperCase() + source.slice(1);
}

async function routeInboundWebhookAction(input: {
  readonly tools: RuntimeToolRegistry;
  readonly webhook: InboundWebhookRecord;
  readonly parsedPayload: unknown;
  readonly eventSubject: string;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  const action = actionConfig(input.webhook.metadata);
  if (action === undefined) {
    return { ok: true };
  }
  if (input.webhook.createdByActorId === null) {
    return { ok: false, error: "Inbound webhook action requires a created_by actor." };
  }
  const result = await input.tools.invoke(
    action.toolId,
    action.input ?? {
      eventSubject: input.eventSubject,
      payload: input.parsedPayload,
      webhookId: input.webhook.id,
    },
    {
      actor: {
        id: input.webhook.createdByActorId,
        orgId: input.webhook.orgId,
        type: "agent",
        scopes: action.scopes,
      },
    },
  );
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

function actionConfig(
  metadata: Record<string, unknown>,
):
  | { readonly toolId: string; readonly input?: unknown; readonly scopes: readonly string[] }
  | undefined {
  const action = metadata.action;
  if (!isRecord(action) || typeof action.toolId !== "string" || action.toolId.length === 0) {
    return undefined;
  }
  const scopes = Array.isArray(action.scopes)
    ? action.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  return {
    toolId: action.toolId,
    ...(action.input === undefined ? {} : { input: action.input }),
    scopes,
  };
}

function bodyToBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  return Buffer.from(JSON.stringify(body ?? {}), "utf8");
}

function safeParseJson(payload: Buffer): unknown {
  try {
    return parseJsonPayload(payload);
  } catch {
    return payload.toString("utf8");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

/** The persisted delivery record drops credential-bearing request headers. */
function compactHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(allHeaders(headers)).filter(
      ([key]) => key !== "authorization" && key !== "cookie",
    ),
  );
}

function allHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([key, value]) => {
      const first = firstHeader(value);
      return first === undefined ? [] : [[key, first]];
    }),
  );
}
