import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { z } from "zod";
import { normalizeMailboxAddress } from "./address-normalization.js";
import { verifyWebhookSignature } from "../webhooks/signatures.js";
import {
  normalizeMailgunDeliveryEvent,
  ProviderWebhookPayloadError,
  ProviderWebhookVerificationError,
  type MailDeliveryEventType,
  type NormalizedMailDeliveryEvent,
} from "./provider-delivery-events.js";

export type FeedbackProvider = "mailgun" | "postmark" | "sendgrid" | "resend" | "cloudflare";
const record = z.record(z.unknown());
const text = z.string().min(1).max(1024);
const seconds = z.number().finite().nonnegative();
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Native provider authentication; Cloudflare Queue events use the documented signed bridge. */
export function verifyProviderFeedback(input: {
  kind: FeedbackProvider;
  rawBody: Buffer;
  secret: string;
  headers: Readonly<Record<string, string | undefined>>;
  now?: number;
  toleranceSeconds?: number;
}): readonly NormalizedMailDeliveryEvent[] {
  const now = input.now ?? Date.now();
  const tolerance = input.toleranceSeconds ?? 300;
  const fresh = (value: unknown): boolean =>
    typeof value === "string" &&
    /^\d+$/u.test(value) &&
    Math.abs(now / 1000 - Number(value)) <= tolerance;
  let raw: unknown;
  try {
    raw = JSON.parse(input.rawBody.toString("utf8"));
  } catch {
    throw new ProviderWebhookPayloadError("Invalid JSON.");
  }
  let authenticated = false;
  try {
    switch (input.kind) {
      case "mailgun": {
        const signature = z
          .object({
            timestamp: z.string(),
            token: z.string().min(1).max(256),
            signature: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .parse(record.parse(raw).signature);
        authenticated =
          fresh(signature.timestamp) &&
          equal(
            signature.signature,
            createHmac("sha256", input.secret)
              .update(signature.timestamp + signature.token)
              .digest("hex"),
          );
        break;
      }
      case "sendgrid": {
        const timestamp = input.headers["x-twilio-email-event-webhook-timestamp"];
        const signature = input.headers["x-twilio-email-event-webhook-signature"];
        authenticated =
          timestamp !== undefined &&
          fresh(timestamp) &&
          signature !== undefined &&
          verify(
            "sha256",
            Buffer.concat([Buffer.from(timestamp), input.rawBody]),
            createPublicKey({
              key: Buffer.from(input.secret, "base64"),
              format: "der",
              type: "spki",
            }),
            Buffer.from(signature, "base64"),
          );
        break;
      }
      case "resend": {
        const timestamp = input.headers["svix-timestamp"],
          id = input.headers["svix-id"];
        const signature = input.headers["svix-signature"];
        if (
          timestamp !== undefined &&
          fresh(timestamp) &&
          id &&
          signature &&
          input.secret.startsWith("whsec_")
        ) {
          const expected = createHmac("sha256", Buffer.from(input.secret.slice(6), "base64"))
            .update(`${id}.${timestamp}.`)
            .update(input.rawBody)
            .digest("base64");
          authenticated = signature.split(" ").some((entry) => equal(entry, `v1,${expected}`));
        }
        break;
      }
      case "postmark":
        authenticated = equal(
          input.headers.authorization ?? "",
          `Basic ${Buffer.from(`helix:${input.secret}`).toString("base64")}`,
        );
        break;
      case "cloudflare":
        authenticated = verifyWebhookSignature({
          payload: input.rawBody,
          secret: input.secret,
          header: input.headers["x-helix-signature"] ?? "",
          now,
          toleranceSeconds: tolerance,
        });
        break;
    }
  } catch {
    authenticated = false;
  }
  if (!authenticated) throw new ProviderWebhookVerificationError();
  try {
    if (input.kind === "mailgun") return [normalizeMailgunDeliveryEvent(raw)];
    const events =
      input.kind === "sendgrid" ? z.array(record).max(1000).parse(raw) : [record.parse(raw)];
    return events.flatMap((event) => normalize(input.kind, event, input.headers["svix-id"]));
  } catch (error) {
    if (error instanceof ProviderWebhookPayloadError) throw error;
    throw new ProviderWebhookPayloadError("Invalid provider event fields.");
  }
}

function normalize(
  kind: FeedbackProvider,
  value: Record<string, unknown>,
  requestId?: string,
): NormalizedMailDeliveryEvent[] {
  let eventName: string,
    messageId: unknown,
    eventId: unknown,
    recipients: unknown[],
    timestamp: unknown;
  let type: MailDeliveryEventType | undefined;
  let handoffKey: string | undefined;
  if (kind === "sendgrid") {
    eventName = text.parse(value.event);
    type = (
      {
        delivered: "delivered",
        deferred: "delayed",
        bounce: value.type === "blocked" ? "soft_bounce" : "hard_bounce",
        dropped: "rejected",
        spamreport: "complaint",
      } as Record<string, MailDeliveryEventType>
    )[eventName];
    if (!type) return [];
    messageId = value["smtp-id"] ?? value.sg_message_id;
    eventId = value.sg_event_id;
    recipients = [value.email];
    timestamp = seconds.parse(value.timestamp) * 1000;
  } else if (kind === "resend") {
    eventName = text.parse(value.type);
    type = (
      {
        "email.delivered": "delivered",
        "email.delivery_delayed": "delayed",
        "email.bounced": "hard_bounce",
        "email.complained": "complaint",
        "email.failed": "rejected",
      } as Record<string, MailDeliveryEventType>
    )[eventName];
    if (!type) return [];
    const data = record.parse(value.data);
    if (type === "hard_bounce" && data.bounce && record.parse(data.bounce).type !== "Permanent")
      type = "soft_bounce";
    messageId = data.email_id;
    eventId = requestId;
    recipients = z.array(text).min(1).max(100).parse(data.to);
    timestamp = value.created_at;
  } else if (kind === "postmark") {
    eventName = text.parse(value.RecordType);
    type =
      eventName === "Delivery"
        ? "delivered"
        : eventName === "SpamComplaint"
          ? "complaint"
          : eventName === "Bounce"
            ? value.Type === "HardBounce"
              ? "hard_bounce"
              : value.Type === "SpamComplaint"
                ? "complaint"
                : "soft_bounce"
            : undefined;
    if (!type) return [];
    const metadata = value.Metadata === undefined ? {} : record.parse(value.Metadata);
    if (metadata.helixHandoffKey !== undefined)
      handoffKey = z.string().uuid().parse(metadata.helixHandoffKey);
    messageId = value.MessageID;
    recipients = [value.Recipient ?? value.Email];
    timestamp = value.DeliveredAt ?? value.BouncedAt;
    eventId =
      value.ID === undefined
        ? `${text.parse(messageId)}:${eventName}:${text.parse(timestamp)}`
        : String(z.union([z.string(), z.number().int().nonnegative()]).parse(value.ID));
  } else {
    eventName = text.parse(value.type);
    type = (
      {
        "cf.email.sending.message.delivered": "delivered",
        "cf.email.sending.message.deferred": "delayed",
        "cf.email.sending.message.bounced": "hard_bounce",
        "cf.email.sending.message.failed": "rejected",
        "cf.email.sending.message.rejected": "rejected",
        "cf.email.sending.message.complained": "complaint",
      } as Record<string, MailDeliveryEventType>
    )[eventName];
    if (!type) return [];
    const payload = record.parse(value.payload);
    messageId = text.parse(payload.messageId).replace(/^<|>$/gu, "");
    eventId = payload.eventId;
    recipients = [payload.recipient];
    timestamp = record.parse(value.metadata).eventTimestamp;
    if (type === "hard_bounce" && payload.bounce && record.parse(payload.bounce).type === "soft")
      type = "soft_bounce";
  }
  const occurredAt = new Date(typeof timestamp === "number" ? timestamp : text.parse(timestamp));
  if (!Number.isFinite(occurredAt.getTime()))
    throw new ProviderWebhookPayloadError("Invalid event date.");
  return recipients.map((recipient) => ({
    providerEventId: `${text.parse(eventId)}:${text.parse(recipient)}`,
    providerMessageId: text.parse(messageId),
    ...(handoffKey === undefined ? {} : { handoffKey }),
    recipient: normalizeMailboxAddress(text.parse(recipient)).address,
    type,
    occurredAt,
    metadata: { provider: kind, event: eventName },
  }));
}
