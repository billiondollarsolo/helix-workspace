import { randomUUID } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { JsonObject } from "@helix/sdk-types";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type {
  MailAttachmentInput,
  MailOutboundDeliveryResult,
  MailOutboundEnvelope,
  MailOutboundRecord,
} from "./types.js";
import type { ClaimedOutboundMail, MailStore, OutboundMailQueueStore } from "./store.js";
import { MailDeliveryError, MailProviderError } from "./errors.js";
import { prepareOutboundEnvelope } from "./threading.js";

export interface OutboundMailConfig {
  readonly host: string;
  readonly port?: number;
  readonly secure?: boolean;
  readonly user?: string;
  readonly pass?: string;
}

export interface OutboundMailTransport {
  /** Repeated calls with the same key must represent one provider submission. */
  send(
    envelope: MailOutboundEnvelope,
    handoff: { readonly idempotencyKey: string },
  ): Promise<MailOutboundDeliveryResult>;
}

export type DkimOptionsResolver = (fromAddress: string) => Promise<
  | {
      readonly domainName: string;
      readonly keySelector: string;
      readonly privateKey: string;
    }
  | null
>;

export type OutboundMailTransportResolver = (
  outbound: MailOutboundRecord,
) => Promise<OutboundMailTransport>;

/** Resolve Drive objectId attachments to bytes before SMTP send. */
export type AttachmentObjectResolver = (
  objectId: string,
  context: { readonly orgId: string; readonly actorId: string },
) => Promise<Buffer>;

export interface MailSendServiceOptions {
  readonly store: MailStore;
  readonly undoWindowMs?: number;
  readonly outboxSubject?: string;
}

export interface OutboundMailWorkerOptions {
  readonly store: OutboundMailQueueStore;
  readonly dispatcher: OutboundMailDispatcher;
  readonly owner?: string;
  readonly leaseMs?: number;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly onError?: (error: unknown) => void;
}

export interface QueueMailInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly threadId?: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly envelope: MailOutboundEnvelope;
  readonly now?: Date;
  readonly sendAt?: Date;
}

export interface OutboundDispatchOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly resolveAttachment?: AttachmentObjectResolver;
  readonly metrics?:
    | {
        recordOperationalEvent(input: {
          readonly capability: "mail";
          readonly operation: "queue_wait" | "delivery";
          readonly status: "success" | "error" | "retry" | "blocked" | "dry_run";
          readonly durationSeconds?: number;
        }): void;
      }
    | undefined;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_LEASE_MS = 5 * 60_000;

export class NodemailerMailTransport implements OutboundMailTransport {
  private readonly transporter: Transporter<SMTPTransport.SentMessageInfo>;

  constructor(
    config: OutboundMailConfig | Transporter<SMTPTransport.SentMessageInfo>,
    private readonly resolveDkim?: DkimOptionsResolver,
  ) {
    this.transporter =
      "sendMail" in config
        ? config
        : nodemailer.createTransport({
            host: config.host,
            port: config.port ?? 587,
            secure: config.secure ?? false,
            ...(config.user === undefined
              ? {}
              : {
                  auth: {
                    user: config.user,
                    pass: config.pass ?? "",
                  },
                }),
          });
  }

  async send(
    envelope: MailOutboundEnvelope,
    handoff: { readonly idempotencyKey: string },
  ): Promise<MailOutboundDeliveryResult> {
    const dkim = await this.resolveDkim?.(envelope.from.address);
    const info = await this.transporter.sendMail({
      from: formatAddress(envelope.from),
      to: envelope.to.map(formatAddress),
      cc: envelope.cc.map(formatAddress),
      bcc: envelope.bcc.map(formatAddress),
      subject: envelope.subject,
      messageId: envelope.messageId,
      inReplyTo: envelope.inReplyTo,
      references: envelope.references === undefined ? undefined : [...envelope.references],
      headers: { "X-Helix-Idempotency-Key": handoff.idempotencyKey },
      text: envelope.text,
      html: envelope.html,
      attachments: envelope.attachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        content: attachmentContent(attachment.content),
      })),
      ...(dkim === undefined || dkim === null ? {} : { dkim }),
    });
    return {
      providerMessageId: info.messageId,
      deliveryMetadata: normalizeDeliveryMetadata(info),
    };
  }
}

function attachmentContent(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (isSerializedBuffer(value)) {
    return Buffer.from(value.data);
  }
  throw new TypeError("Outbound mail attachment content must be a Buffer.");
}

function isSerializedBuffer(value: unknown): value is { readonly data: readonly number[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { readonly type?: unknown }).type === "Buffer" &&
    Array.isArray((value as { readonly data?: unknown }).data)
  );
}

/**
 * Resolve Drive object references and reject malformed attachment envelopes.
 */
export async function resolveOutboundAttachments(
  envelope: MailOutboundEnvelope,
  resolveObject?: AttachmentObjectResolver,
  context?: { readonly orgId: string; readonly actorId: string },
): Promise<MailOutboundEnvelope> {
  if (envelope.attachments.length === 0) {
    return envelope;
  }
  const attachments: MailAttachmentInput[] = [];
  for (const attachment of envelope.attachments) {
    if (attachment.objectId !== undefined && attachment.objectId.length > 0) {
      if (resolveObject === undefined || context === undefined) {
        throw new MailDeliveryError(
          `Attachment objectId ${attachment.objectId} requires a Drive resolver.`,
          false,
          { cause: new Error("missing_attachment_resolver") },
        );
      }
      const content = await resolveObject(attachment.objectId, context);
      attachments.push({
        ...attachment,
        content,
      });
      continue;
    }
    if (attachment.content === undefined) {
      throw new MailDeliveryError("Outbound mail attachment is missing content.", false, {
        cause: new Error("missing_attachment_content"),
      });
    }
    attachments.push(attachment);
  }
  return { ...envelope, attachments };
}

export class MailSendService {
  private readonly undoWindowMs: number;
  private readonly outboxSubject: string;

  constructor(private readonly options: MailSendServiceOptions) {
    this.undoWindowMs = options.undoWindowMs ?? 30_000;
    this.outboxSubject = options.outboxSubject ?? "mail.send";
  }

  queue(input: QueueMailInput): Promise<MailOutboundRecord> {
    const now = input.now ?? new Date();
    const sendAt = input.sendAt;
    if (
      sendAt !== undefined &&
      (!Number.isFinite(sendAt.getTime()) ||
        sendAt <= now ||
        sendAt.getTime() - now.getTime() > 366 * 24 * 60 * 60_000)
    ) {
      throw new RangeError("Scheduled mail must be sent within the next 366 days.");
    }
    const envelope = prepareOutboundEnvelope({
      ...input.envelope,
      ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
      ...(input.references === undefined ? {} : { references: input.references }),
    });
    return this.options.store.createOutbound({
      orgId: input.orgId,
      actorId: input.actorId,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      envelope,
      undoUntil: sendAt ?? new Date(now.getTime() + this.undoWindowMs),
      outboxSubject: this.outboxSubject,
    });
  }

  cancel(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<MailOutboundRecord | null> {
    return this.options.store.cancelOutbound(input);
  }
}

export class OutboundMailDispatcher {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly resolveAttachment: AttachmentObjectResolver | undefined;
  private readonly metrics: OutboundDispatchOptions["metrics"];

  constructor(
    private readonly store: OutboundMailQueueStore,
    private readonly resolveTransport: OutboundMailTransportResolver,
    options: OutboundDispatchOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.resolveAttachment = options.resolveAttachment;
    this.metrics = options.metrics;
  }

  async dispatch(outbound: ClaimedOutboundMail): Promise<MailOutboundRecord | null> {
    const startedAt = Date.now();
    this.metrics?.recordOperationalEvent({
      capability: "mail",
      operation: "queue_wait",
      status: "success",
      durationSeconds: Math.max(0, this.now().getTime() - outbound.undoUntil.getTime()) / 1_000,
    });
    const recordDelivery = (status: "success" | "error" | "retry") =>
      this.metrics?.recordOperationalEvent({
        capability: "mail",
        operation: "delivery",
        status,
        durationSeconds: (Date.now() - startedAt) / 1_000,
      });
    // P2-6: an `smtp.send` span covers the SMTP delivery of one queued message.
    return trace
      .getTracer("helix.mail")
      .startActiveSpan(
        "smtp.send",
        { attributes: { "helix.mail.outbound_id": outbound.id } },
        async (span) => {
          try {
            span.setAttribute("helix.mail.attempt", outbound.attemptCount);
            let delivery: MailOutboundDeliveryResult;
            try {
              const resolved = await resolveOutboundAttachments(
                outbound.envelope,
                this.resolveAttachment,
                { orgId: outbound.orgId, actorId: outbound.actorId },
              );
              const transport = await this.resolveTransport(outbound);
              delivery = await transport.send(resolved, {
                idempotencyKey: outbound.handoffKey,
              });
            } catch (error) {
              span.recordException(error instanceof Error ? error : new Error(String(error)));
              span.setStatus({ code: SpanStatusCode.ERROR });
              const message = error instanceof Error ? error.message : String(error);
              if (outbound.attemptCount >= this.maxAttempts || isTerminalDeliveryError(error)) {
                span.setAttribute("helix.mail.delivery_status", "dead_lettered");
                recordDelivery("error");
                return await this.store.markOutboundDeadLettered({
                  id: outbound.id,
                  leaseToken: outbound.leaseToken,
                  lastError: new MailProviderError(message, error).message,
                });
              }
              const delay = computeBackoffMs(
                outbound.attemptCount,
                this.baseDelayMs,
                this.maxDelayMs,
                this.random,
              );
              span.setAttribute("helix.mail.delivery_status", "retry");
              span.setAttribute("helix.mail.next_delay_ms", delay);
              recordDelivery("retry");
              return await this.store.markOutboundRetry({
                id: outbound.id,
                leaseToken: outbound.leaseToken,
                nextAttemptAt: new Date(this.now().getTime() + delay),
                lastError: message,
              });
            }
            span.setAttribute("helix.mail.delivery_status", "sent");
            recordDelivery("success");
            return await this.store.markOutboundSent({
              id: outbound.id,
              leaseToken: outbound.leaseToken,
              providerMessageId: delivery.providerMessageId,
              deliveryMetadata: delivery.deliveryMetadata,
            });
          } finally {
            span.end();
          }
        },
      );
  }
}

/** Exponential backoff with equal jitter: bounded away from zero to prevent hot loops. */
export function computeBackoffMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.floor(exp / 2 + random() * (exp / 2)));
}

export class OutboundMailWorker {
  private readonly owner: string;
  private readonly leaseMs: number;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly onError: ((error: unknown) => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private activeDrain: Promise<number> | undefined;

  constructor(private readonly options: OutboundMailWorkerOptions) {
    this.owner = options.owner ?? randomUUID();
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.intervalMs = options.intervalMs ?? 1_000;
    this.batchSize = options.batchSize ?? 100;
    this.onError = options.onError;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.runScheduledDrain(), this.intervalMs);
    void this.runScheduledDrain();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeDrain;
  }

  async drainOnce(now?: Date): Promise<number> {
    let attempted = 0;
    while (attempted < this.batchSize) {
      const outbound = await this.options.store.claimDueOutbound({
        owner: this.owner,
        leaseMs: this.leaseMs,
        ...(now === undefined ? {} : { now }),
      });
      if (outbound === null) break;
      await this.options.dispatcher.dispatch(outbound);
      attempted += 1;
    }
    return attempted;
  }

  private runScheduledDrain(): Promise<number> {
    if (this.activeDrain !== undefined) return this.activeDrain;
    this.activeDrain = this.drainOnce()
      .catch((error: unknown) => {
        this.onError?.(error);
        return 0;
      })
      .finally(() => {
        this.activeDrain = undefined;
      });
    return this.activeDrain;
  }
}

export function isTerminalDeliveryError(error: unknown): boolean {
  if (error instanceof MailDeliveryError) return !error.retryable;
  if (error instanceof TypeError) return true;
  if (typeof error !== "object" || error === null) return false;
  const value = error as { readonly retryable?: unknown; readonly responseCode?: unknown };
  if (typeof value.retryable === "boolean") return !value.retryable;
  return typeof value.responseCode === "number" && value.responseCode >= 500;
}

function formatAddress(address: { readonly address: string; readonly name?: string }): string {
  return address.name === undefined
    ? address.address
    : `"${address.name.replaceAll('"', '\\"')}" <${address.address}>`;
}

function normalizeDeliveryMetadata(info: SMTPTransport.SentMessageInfo): JsonObject {
  const timedInfo = info as SMTPTransport.SentMessageInfo & {
    readonly envelopeTime?: number;
    readonly messageTime?: number;
    readonly messageSize?: number;
  };
  const metadata: unknown = JSON.parse(
    JSON.stringify({
      accepted: info.accepted,
      rejected: info.rejected,
      pending: info.pending,
      response: info.response,
      envelope: info.envelope,
      envelopeTime: timedInfo.envelopeTime ?? null,
      messageTime: timedInfo.messageTime ?? null,
      messageSize: timedInfo.messageSize ?? null,
    }),
  );
  return metadata as JsonObject;
}
