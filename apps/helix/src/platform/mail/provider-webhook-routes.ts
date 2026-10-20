import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import {
  adminConsoleWriteScope,
  canWriteAdminConsole,
  notFound,
  sendForbidden,
  type AdminConsoleAuditSink,
} from "../admin/console-shared.js";
import type { OutboundProviderStore } from "./admin-store.js";
import {
  clearMailSuppressionWithAudit,
  ProviderWebhookPayloadError,
  ProviderWebhookUnmatchedError,
  ProviderWebhookVerificationError,
  type MailDeliveryAlertMonitor,
  type ProviderDeliveryEventStore,
} from "./delivery-events.js";
import { resolveMailProviderSecret, type MailSecretProvider } from "./outbound-routing.js";
import { verifyProviderFeedback, type FeedbackProvider } from "./provider-feedback.js";
import { verifySesFeedback } from "./ses-feedback.js";
import { isSesSmtpHost } from "./threading.js";

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
  readonly deliveryStore: ProviderDeliveryEventStore;
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
    if (provider === null) {
      return reply.code(404).send({ error: "Unknown provider webhook." });
    }
    if (
      provider.kind === "ses" ||
      (provider.kind === "smtp" &&
        typeof provider.config.host === "string" &&
        isSesSmtpHost(provider.config.host))
    ) {
      if (typeof provider.config.feedbackTopicArn !== "string")
        return reply
          .code(503)
          .send({ error: "Configure this provider's SES feedback topic ARN first." });
      try {
        const raw = rawProviderWebhookBodies.get(request) ?? bodyToBuffer(request.body);
        const result = await verifySesFeedback(
          JSON.parse(raw.toString("utf8")),
          provider.config.feedbackTopicArn,
        );
        const events = [];
        for (const event of result.events) {
          events.push(
            await options.deliveryStore.ingestEvent({
              orgId: provider.orgId,
              providerId: provider.id,
              event,
            }),
          );
          await options.alertMonitor?.observe(provider.orgId, event.type);
        }
        return await reply.code(202).send({
          accepted: true,
          subscriptionConfirmed: result.subscriptionConfirmed,
          events: events.map((event) => ({
            duplicate: event.duplicate,
            outboundMatched: event.outboundMatched,
            suppressed: event.suppressed,
          })),
        });
      } catch (error) {
        if (error instanceof ProviderWebhookVerificationError) {
          options.onSignatureFailure?.({ orgId: provider.orgId, providerId: provider.id });
          return reply.code(401).send({ error: "Invalid SES feedback signature or topic." });
        }
        if (error instanceof ProviderWebhookPayloadError || error instanceof SyntaxError)
          return reply.code(400).send({ error: "Invalid SES feedback payload." });
        throw error;
      }
    }
    const feedbackKind =
      provider.kind === "smtp" ? provider.config.feedbackProvider : provider.kind;
    if (
      typeof feedbackKind !== "string" ||
      !["mailgun", "postmark", "sendgrid", "resend", "cloudflare"].includes(feedbackKind)
    )
      return reply
        .code(422)
        .send({ error: "Configure a supported delivery feedback provider first." });
    const signingSecret = await resolveMailProviderSecret(options.secrets, provider, "feedback");
    if (!signingSecret)
      return reply.code(503).send({ error: "Provider feedback credential is not configured." });
    try {
      const normalized = verifyProviderFeedback({
        kind: feedbackKind as FeedbackProvider,
        rawBody: rawProviderWebhookBodies.get(request) ?? bodyToBuffer(request.body),
        secret: signingSecret,
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([key, value]) => [key, firstHeader(value)]),
        ),
        ...(options.replayToleranceSeconds === undefined
          ? {}
          : { toleranceSeconds: options.replayToleranceSeconds }),
      });
      const events = [];
      for (const event of normalized) {
        let result;
        try {
          result = await options.deliveryStore.ingestEvent({
            orgId: provider.orgId,
            providerId: provider.id,
            event,
          });
        } catch (error) {
          // Postmark setup probes and other applications have no Helix handoff metadata.
          if (
            feedbackKind === "postmark" &&
            event.handoffKey === undefined &&
            error instanceof ProviderWebhookUnmatchedError
          )
            continue;
          throw error;
        }
        if (!result.duplicate) await options.alertMonitor?.observe(provider.orgId, event.type);
        events.push({
          duplicate: result.duplicate,
          eventId: result.event.id,
          outboundMatched: result.outboundMatched,
          suppressed: result.suppressed,
        });
      }
      return await reply
        .code(200)
        .send({ accepted: true, ...(events.length === 1 ? events[0] : {}), events });
    } catch (error) {
      if (error instanceof ProviderWebhookVerificationError) {
        options.onSignatureFailure?.({ orgId: provider.orgId, providerId: provider.id });
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
  readonly store: ProviderDeliveryEventStore;
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
      events: await options.store.listProviderEvents({
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
