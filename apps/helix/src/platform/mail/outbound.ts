import nodemailer, { type Transporter } from "nodemailer";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { EventBus, EventEnvelope, JsonObject, Unsubscribe } from "@helix/sdk-types";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type {
  MailAttachmentInput,
  MailOutboundDeliveryResult,
  MailOutboundEnvelope,
  MailOutboundRecord,
} from "./types.js";
import type { MailStore } from "./store.js";
import {
  MailAttachmentSizeError,
  MailOutboundPayloadError,
  MailProviderConfigurationError,
  MailProviderError,
  MailSendIdempotencyRequiredError,
} from "./errors.js";
import { normalizeMailboxAddress } from "./address-normalization.js";
import {
  providerDecisionMetadata,
  type OutboundTransportFor,
  type ResolvedOutboundTransport,
} from "./outbound-routing.js";

export interface OutboundMailConfig {
  readonly host: string;
  readonly port?: number;
  readonly secure?: boolean;
  readonly user?: string;
  readonly pass?: string;
}

export interface OutboundMailTransport {
  send(envelope: MailOutboundEnvelope): Promise<MailOutboundDeliveryResult>;
}

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
  readonly events: EventBus;
  readonly dispatcher: OutboundMailDispatcher;
  readonly subject?: string;
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
  readonly source?: "interactive" | "api" | "agent";
  readonly idempotencyKey?: string;
}

export interface OutboundDispatchOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly resolveAttachment?: AttachmentObjectResolver;
  readonly suppressionStore?: {
    findActiveSuppressions(
      orgId: string,
      normalizedRecipients: readonly string[],
    ): Promise<readonly { readonly normalizedRecipient: string }[]>;
  };
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 60_000;
/** Leaves headroom for base64/MIME expansion below the common 25 MiB provider limit. */
export const MAIL_MAX_OUTBOUND_ATTACHMENT_BYTES = 18 * 1024 * 1024;

export class NodemailerMailTransport implements OutboundMailTransport {
  private readonly transporter: Transporter<SMTPTransport.SentMessageInfo>;

  constructor(config: OutboundMailConfig | Transporter<SMTPTransport.SentMessageInfo>) {
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

  async send(envelope: MailOutboundEnvelope): Promise<MailOutboundDeliveryResult> {
    const info = await this.transporter.sendMail({
      from: formatAddress(envelope.from),
      to: envelope.to.map(formatAddress),
      cc: envelope.cc.map(formatAddress),
      bcc: envelope.bcc.map(formatAddress),
      subject: envelope.subject,
      text: envelope.text,
      html: envelope.html,
      attachments: envelope.attachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        content: attachmentContent(attachment.content),
        path: attachment.path,
      })),
    });
    return {
      providerMessageId: info.messageId,
      deliveryMetadata: normalizeDeliveryMetadata(info),
    };
  }
}

function attachmentContent(value: unknown): Buffer {
  if (value === undefined || value === null) {
    return Buffer.alloc(0);
  }
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
 * Resolve any `objectId` attachments via the Drive storage resolver while
 * preserving inline base64/buffer content (back-compat).
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
  let totalBytes = 0;
  for (const attachment of envelope.attachments) {
    if (attachment.objectId !== undefined && attachment.objectId.length > 0) {
      if (resolveObject === undefined || context === undefined) {
        throw new MailProviderError(
          `Attachment objectId ${attachment.objectId} requires a Drive resolver.`,
          new Error("missing_attachment_resolver"),
        );
      }
      const content = await resolveObject(attachment.objectId, context);
      totalBytes = addAttachmentBytes(totalBytes, content.byteLength);
      attachments.push({
        ...attachment,
        content,
      });
      continue;
    }
    totalBytes = addAttachmentBytes(totalBytes, attachment.content?.byteLength ?? 0);
    attachments.push({
      ...attachment,
      content: attachment.content ?? Buffer.alloc(0),
    });
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
    if (
      input.source !== undefined &&
      input.source !== "interactive" &&
      (input.idempotencyKey === undefined || input.idempotencyKey.trim().length === 0)
    ) {
      throw new MailSendIdempotencyRequiredError();
    }
    assertKnownOutboundAttachmentSizes(input.envelope);
    const now = input.now ?? new Date();
    return this.options.store.createOutbound({
      orgId: input.orgId,
      actorId: input.actorId,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
      ...(input.references === undefined ? {} : { references: input.references }),
      envelope: input.envelope,
      undoUntil: new Date(now.getTime() + this.undoWindowMs),
      outboxSubject: this.outboxSubject,
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: input.idempotencyKey.trim() }),
    });
  }

  cancel(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<MailOutboundRecord | null> {
    return this.options.store.cancelOutbound(input);
  }

  retry(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<MailOutboundRecord | null> {
    if (this.options.store.retryOutbound === undefined) {
      return Promise.resolve(null);
    }
    return this.options.store.retryOutbound({
      ...input,
      outboxSubject: this.outboxSubject,
    });
  }
}

function assertKnownOutboundAttachmentSizes(envelope: MailOutboundEnvelope): void {
  let totalBytes = 0;
  for (const attachment of envelope.attachments) {
    totalBytes = addAttachmentBytes(totalBytes, attachment.content?.byteLength ?? 0);
  }
}

function addAttachmentBytes(totalBytes: number, attachmentBytes: number): number {
  if (
    attachmentBytes > MAIL_MAX_OUTBOUND_ATTACHMENT_BYTES ||
    totalBytes + attachmentBytes > MAIL_MAX_OUTBOUND_ATTACHMENT_BYTES
  ) {
    throw new MailAttachmentSizeError(MAIL_MAX_OUTBOUND_ATTACHMENT_BYTES);
  }
  return totalBytes + attachmentBytes;
}

export class OutboundMailDispatcher {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly resolveAttachment: AttachmentObjectResolver | undefined;
  private readonly suppressionStore: OutboundDispatchOptions["suppressionStore"];
  private readonly transportFor: OutboundTransportFor | undefined;
  private readonly legacyTransport: OutboundMailTransport | undefined;

  constructor(
    private readonly store: MailStore,
    transport: OutboundMailTransport | OutboundTransportFor,
    options: OutboundDispatchOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.resolveAttachment = options.resolveAttachment;
    this.suppressionStore = options.suppressionStore;
    if (typeof transport === "function") {
      this.transportFor = transport;
      this.legacyTransport = undefined;
    } else {
      this.transportFor = undefined;
      this.legacyTransport = transport;
    }
  }

  async dispatch(outboundId: string): Promise<MailOutboundRecord | null> {
    // P2-6: an `smtp.send` span covers the SMTP delivery of one queued message.
    return trace
      .getTracer("helix.mail")
      .startActiveSpan(
        "smtp.send",
        { attributes: { "helix.mail.outbound_id": outboundId } },
        async (span) => {
          try {
            const outbound = await this.store.markOutboundSending(outboundId);
            if (outbound === null) {
              span.setAttribute("helix.mail.dispatch_skipped", true);
              return null;
            }

            let decision: ResolvedOutboundTransport | undefined;
            try {
              await this.#assertRecipientsNotSuppressed(outbound);
              decision = await this.#resolveTransport(outbound);
              if (decision !== undefined && this.store.bindOutboundProviderDecision !== undefined) {
                const bound = await this.store.bindOutboundProviderDecision({
                  id: outbound.id,
                  orgId: outbound.orgId,
                  providerId: decision.providerId,
                  providerKind: decision.providerKind,
                  source: decision.source,
                });
                if (bound === null) {
                  throw new MailProviderConfigurationError(
                    "MAIL_PROVIDER_DECISION_CONFLICT",
                    "A different provider is already bound to this queued message.",
                  );
                }
              }
            } catch (error) {
              if (error instanceof MailProviderConfigurationError) {
                span.setAttribute("helix.mail.delivery_status", "configuration_failed");
                span.setAttribute("helix.mail.operator_code", error.operatorCode);
                span.setStatus({ code: SpanStatusCode.ERROR });
                return await (this.store.markOutboundDeadLettered === undefined
                  ? this.store.markOutboundFailed(outbound.id, error.message)
                  : this.store.markOutboundDeadLettered({
                      id: outbound.id,
                      lastError: error.message,
                    }));
              }
              throw error;
            }

            let attempt = outbound.attemptCount ?? 0;
            let lastError: unknown;

            while (attempt < this.maxAttempts) {
              attempt += 1;
              span.setAttribute("helix.mail.attempt", attempt);
              try {
                const resolved = await resolveOutboundAttachments(
                  outbound.envelope,
                  this.resolveAttachment,
                  { orgId: outbound.orgId, actorId: outbound.actorId },
                );
                const delivery = await (
                  decision?.transport ?? this.#requiredLegacyTransport()
                ).send(resolved);
                const deliveryMetadata = {
                  ...(delivery.deliveryMetadata ?? {}),
                  ...(decision === undefined ? {} : providerDecisionMetadata(decision)),
                  attempt,
                };
                span.setAttribute("helix.mail.delivery_status", "sent");
                return await this.store.markOutboundSent({
                  id: outbound.id,
                  providerMessageId: delivery.providerMessageId,
                  deliveryMetadata,
                });
              } catch (error) {
                lastError = error;
                span.recordException(error instanceof Error ? error : new Error(String(error)));
                const message = error instanceof Error ? error.message : String(error);

                if (attempt >= this.maxAttempts || isNonRetryableDispatchError(error)) {
                  span.setAttribute("helix.mail.delivery_status", "dead_lettered");
                  span.setStatus({ code: SpanStatusCode.ERROR });
                  const wrapped = new MailProviderError(message, error);
                  if (this.store.markOutboundDeadLettered !== undefined) {
                    return await this.store.markOutboundDeadLettered({
                      id: outbound.id,
                      lastError: wrapped.message,
                    });
                  }
                  return await this.store.markOutboundFailed(outbound.id, wrapped.message);
                }

                const delay = computeBackoffMs(attempt, this.baseDelayMs, this.maxDelayMs);
                span.setAttribute("helix.mail.delivery_status", "retry");
                span.setAttribute("helix.mail.next_delay_ms", delay);
                if (this.store.markOutboundRetry !== undefined) {
                  await this.store.markOutboundRetry({
                    id: outbound.id,
                    attemptCount: attempt,
                    nextAttemptAt: new Date(Date.now() + delay),
                    lastError: message,
                  });
                } else {
                  await this.store.markOutboundFailed(outbound.id, message);
                }
                await this.sleep(delay);
              }
            }

            const message =
              lastError instanceof Error
                ? lastError.message
                : typeof lastError === "string"
                  ? lastError
                  : "unknown";
            span.setAttribute("helix.mail.delivery_status", "failed");
            span.setStatus({ code: SpanStatusCode.ERROR });
            return await this.store.markOutboundFailed(outbound.id, message);
          } finally {
            span.end();
          }
        },
      );
  }

  async dispatchOutboxPayload(payload: unknown): Promise<MailOutboundRecord | null> {
    const parsed = mailOutboxPayloadSchema(payload);
    return this.dispatch(parsed.mailOutboundId);
  }

  async #resolveTransport(
    outbound: MailOutboundRecord,
  ): Promise<ResolvedOutboundTransport | undefined> {
    if (this.transportFor === undefined) {
      return undefined;
    }
    const fromDomain = normalizeMailboxAddress(outbound.envelope.from.address).domain;
    return this.transportFor(outbound.orgId, fromDomain, outbound.providerId ?? null);
  }

  #requiredLegacyTransport(): OutboundMailTransport {
    if (this.legacyTransport === undefined) {
      throw new MailProviderConfigurationError(
        "MAIL_PROVIDER_NOT_CONFIGURED",
        "No outbound transport was resolved.",
      );
    }
    return this.legacyTransport;
  }

  async #assertRecipientsNotSuppressed(outbound: MailOutboundRecord): Promise<void> {
    if (this.suppressionStore === undefined) {
      return;
    }
    const recipients = [
      ...outbound.envelope.to,
      ...outbound.envelope.cc,
      ...outbound.envelope.bcc,
    ].map((recipient) => normalizeMailboxAddress(recipient.address).address);
    const suppressed = await this.suppressionStore.findActiveSuppressions(
      outbound.orgId,
      recipients,
    );
    if (suppressed.length > 0) {
      throw new MailProviderConfigurationError(
        "MAIL_RECIPIENT_SUPPRESSED",
        `Delivery is blocked for ${suppressed[0]?.normalizedRecipient ?? "a suppressed recipient"}.`,
      );
    }
  }
}

function isNonRetryableDispatchError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    (error as { readonly retryable?: unknown }).retryable === false
  );
}

/** Exponential backoff with full jitter, capped at maxDelayMs. */
export function computeBackoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * exp);
}

export class OutboundMailWorker {
  private readonly subject: string;
  private readonly onError: ((error: unknown) => void) | undefined;
  private unsubscribe: Unsubscribe | undefined;

  constructor(private readonly options: OutboundMailWorkerOptions) {
    this.subject = options.subject ?? "mail.send";
    this.onError = options.onError;
  }

  async start(): Promise<void> {
    if (this.unsubscribe !== undefined) {
      return;
    }

    this.unsubscribe = await this.options.events.subscribe(this.subject, async (event) => {
      await this.handle(event);
    });
  }

  async stop(): Promise<void> {
    if (this.unsubscribe === undefined) {
      return;
    }

    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    await unsubscribe();
  }

  async handle(event: EventEnvelope): Promise<MailOutboundRecord | null> {
    try {
      return await this.options.dispatcher.dispatchOutboxPayload(event.payload);
    } catch (error) {
      this.onError?.(error);
      throw error;
    }
  }
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

function mailOutboxPayloadSchema(value: unknown): { readonly mailOutboundId: string } {
  if (
    typeof value === "object" &&
    value !== null &&
    "mailOutboundId" in value &&
    typeof value.mailOutboundId === "string"
  ) {
    return { mailOutboundId: value.mailOutboundId };
  }
  throw new MailOutboundPayloadError();
}
