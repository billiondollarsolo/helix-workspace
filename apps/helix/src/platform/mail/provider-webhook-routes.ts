import { Readable } from "node:stream";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod3";
import {
  adminConsoleWriteScope,
  canWriteAdminConsole,
  notFound,
  sendForbidden,
  type AdminConsoleAuditSink,
} from "../admin/console-shared.js";
import type { MailSecretProvider } from "./outbound-routing.js";
import type { OutboundProviderStore } from "./admin-store.js";
import {
  clearMailSuppressionWithAudit,
  ProviderWebhookPayloadError,
  ProviderWebhookVerificationError,
  verifyAndIngestProviderWebhook,
  type MailDeliveryEventStore,
  type MailDeliveryAlertMonitor,
} from "./delivery-events.js";

const rawProviderWebhookBodies = new WeakMap<object, Buffer>();
const webhookParams = z.object({
  orgId: z.string().uuid(),
  providerId: z.string().uuid(),
});
const outboundParams = z.object({ id: z.string().uuid() });
const suppressionParams = z.object({ id: z.string().uuid() });
const clearSuppressionBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

export interface RegisterMailProviderWebhookRoutesOptions {
  readonly providerStore: OutboundProviderStore;
  readonly deliveryStore: MailDeliveryEventStore;
  readonly secrets: MailSecretProvider;
  readonly replayToleranceSeconds?: number;
  readonly onSignatureFailure?: (input: {
    readonly orgId: string;
    readonly providerId: string;
  }) => void;
  readonly alertMonitor?: MailDeliveryAlertMonitor;
  readonly maxBodyBytes?: number;
}

export class ProviderWebhookBodyTooLargeError extends Error {
  readonly statusCode = 413;

  constructor(readonly maxBodyBytes: number) {
    super(`Provider webhook body exceeds the ${String(maxBodyBytes)} byte limit.`);
    this.name = "ProviderWebhookBodyTooLargeError";
  }
}

/**
 * Public managed-provider webhook endpoint. The organization is explicit in
 * the URL, but every lookup and event mutation also matches the provider and
 * organization; a caller-controlled path can never widen tenant scope.
 */
export async function registerMailProviderWebhookRoutes(
  app: FastifyInstance,
  options: RegisterMailProviderWebhookRoutesOptions,
): Promise<void> {
  app.addHook("preParsing", (request, _reply, payload, done) => {
    if (!request.url.startsWith("/webhooks/mail/providers/")) {
      done(null, payload);
      return;
    }
    void readBoundedPayload(
      payload,
      options.maxBodyBytes ?? app.initialConfig.bodyLimit ?? 1024 * 1024,
    )
      .then((rawBody) => {
        rawProviderWebhookBodies.set(request, rawBody);
        const replay = Readable.from(rawBody);
        (replay as Readable & { receivedEncodedLength?: number }).receivedEncodedLength =
          rawBody.length;
        done(null, replay);
      })
      .catch((error: unknown) => {
        done(error instanceof Error ? error : new Error("Unable to read provider webhook body."));
      });
  });

  app.post("/webhooks/mail/providers/:orgId/:providerId", async (request, reply) => {
    const params = webhookParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(404).send({ error: "Unknown provider webhook." });
    }
    const provider = await options.providerStore.getProvider(
      params.data.orgId,
      params.data.providerId,
    );
    if (
      provider === null ||
      !provider.enabled ||
      provider.webhookSecretRef === null ||
      provider.webhookSecretRef === undefined
    ) {
      return reply.code(404).send({ error: "Unknown provider webhook." });
    }
    if (provider.kind !== "mailgun") {
      return reply.code(422).send({ error: "Provider does not support signed delivery webhooks." });
    }
    const signingSecret = await options.secrets.resolveSecret(provider.webhookSecretRef);
    if (signingSecret === undefined || signingSecret.length === 0) {
      return reply.code(503).send({ error: "Provider webhook signing is not configured." });
    }
    const signatureHeader = firstHeader(request.headers["x-helix-signature"]);
    if (signatureHeader === undefined) {
      options.onSignatureFailure?.({
        orgId: provider.orgId,
        providerId: provider.id,
      });
      return reply.code(401).send({ error: "Invalid provider webhook signature." });
    }
    try {
      const result = await verifyAndIngestProviderWebhook({
        orgId: provider.orgId,
        providerId: provider.id,
        providerKind: "mailgun",
        rawBody: rawProviderWebhookBodies.get(request) ?? bodyToBuffer(request.body),
        signatureHeader,
        signingSecret,
        store: options.deliveryStore,
        ...(options.replayToleranceSeconds === undefined
          ? {}
          : { replayToleranceSeconds: options.replayToleranceSeconds }),
        ...(options.onSignatureFailure === undefined
          ? {}
          : { onSignatureFailure: options.onSignatureFailure }),
        ...(options.alertMonitor === undefined ? {} : { alertMonitor: options.alertMonitor }),
      });
      return await reply.code(202).send({
        accepted: true,
        duplicate: result.duplicate,
        eventId: result.event.id,
        outboundMatched: result.outboundMatched,
        suppressed: result.suppressed,
      });
    } catch (error) {
      if (error instanceof ProviderWebhookVerificationError) {
        return reply.code(401).send({ error: "Invalid provider webhook signature." });
      }
      if (error instanceof ProviderWebhookPayloadError || error instanceof SyntaxError) {
        return reply.code(400).send({ error: "Invalid provider webhook payload." });
      }
      throw error;
    }
  });
}

export interface RegisterMailDeliveryEventAdminRoutesOptions {
  readonly store: MailDeliveryEventStore;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly auditSink: AdminConsoleAuditSink;
}

export async function registerMailDeliveryEventAdminRoutes(
  app: FastifyInstance,
  options: RegisterMailDeliveryEventAdminRoutesOptions,
): Promise<void> {
  app.get("/api/admin/mail/outbound/:id/events", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadMailEvents(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = outboundParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send(notFound("Outbound message not found."));
    return {
      events: await options.store.listEvents({
        orgId: actor.orgId,
        outboundId: params.data.id,
      }),
    };
  });

  app.delete("/api/admin/mail/suppressions/:id", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWriteMailEvents(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = suppressionParams.safeParse(request.params);
    const body = clearSuppressionBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid suppression clear request." });
    }
    const cleared = await clearMailSuppressionWithAudit({
      store: options.store,
      auditSink: options.auditSink,
      orgId: actor.orgId,
      actorId: actor.id,
      suppressionId: params.data.id,
      reason: body.data.reason,
    });
    if (cleared === null) {
      return reply.code(404).send(notFound("Active suppression not found."));
    }
    return { suppression: cleared };
  });
}

function canReadMailEvents(actor: Actor): boolean {
  return (
    canWriteAdminConsole(actor) ||
    (actor.scopes ?? []).some((scope) => scope === "mail.admin" || scope === "admin.console.read")
  );
}

function canWriteMailEvents(actor: Actor): boolean {
  return canWriteAdminConsole(actor) || (actor.scopes ?? []).includes("mail.admin");
}

export async function readBoundedPayload(payload: Readable, maxBodyBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of payload as AsyncIterable<Buffer | string | Uint8Array>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.length;
    if (receivedBytes > maxBodyBytes) {
      payload.destroy();
      throw new ProviderWebhookBodyTooLargeError(maxBodyBytes);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, receivedBytes);
}

function bodyToBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.from(JSON.stringify(value ?? {}), "utf8");
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string" || value === undefined) return value;
  return value[0];
}
