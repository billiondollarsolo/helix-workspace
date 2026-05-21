import nodemailer, { type Transporter } from "nodemailer";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { EventBus, EventEnvelope, JsonObject, Unsubscribe } from "@helix/sdk-types";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type {
  MailOutboundDeliveryResult,
  MailOutboundEnvelope,
  MailOutboundRecord,
} from "./types.js";
import type { MailStore } from "./store.js";

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
}

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

export class MailSendService {
  private readonly undoWindowMs: number;
  private readonly outboxSubject: string;

  constructor(private readonly options: MailSendServiceOptions) {
    this.undoWindowMs = options.undoWindowMs ?? 30_000;
    this.outboxSubject = options.outboxSubject ?? "mail.send";
  }

  queue(input: QueueMailInput): Promise<MailOutboundRecord> {
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
  constructor(
    private readonly store: MailStore,
    private readonly transport: OutboundMailTransport,
  ) {}

  async dispatch(outboundId: string): Promise<MailOutboundRecord | null> {
    // P2-6: an `smtp.send` span covers the SMTP delivery of one queued message.
    return trace.getTracer("helix.mail").startActiveSpan(
      "smtp.send",
      { attributes: { "helix.mail.outbound_id": outboundId } },
      async (span) => {
        try {
          const outbound = await this.store.markOutboundSending(outboundId);
          if (outbound === null) {
            span.setAttribute("helix.mail.dispatch_skipped", true);
            return null;
          }

          try {
            const delivery = await this.transport.send(outbound.envelope);
            span.setAttribute("helix.mail.delivery_status", "sent");
            return await this.store.markOutboundSent({
              id: outbound.id,
              providerMessageId: delivery.providerMessageId,
              deliveryMetadata: delivery.deliveryMetadata,
            });
          } catch (error) {
            span.setAttribute("helix.mail.delivery_status", "failed");
            span.recordException(error instanceof Error ? error : new Error(String(error)));
            span.setStatus({ code: SpanStatusCode.ERROR });
            return await this.store.markOutboundFailed(
              outbound.id,
              error instanceof Error ? error.message : String(error),
            );
          }
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
  throw new Error("Invalid mail.send outbox payload.");
}
