import { verify, X509Certificate } from "node:crypto";
import { z } from "zod";
import { createOutboundHttpClient } from "../outbound-http.js";
import {
  ProviderWebhookPayloadError,
  ProviderWebhookVerificationError,
  type NormalizedMailDeliveryEvent,
} from "./provider-delivery-events.js";

export const sesFeedbackTopicArnSchema = z
  .string()
  .regex(/^arn:aws:sns:[a-z]{2}-[a-z]+-\d:\d{12}:[A-Za-z0-9_-]{1,256}$/u);
const envelopeSchema = z.object({
  Type: z.enum(["Notification", "SubscriptionConfirmation"]),
  Message: z.string().max(1024 * 1024),
  MessageId: z.string().min(1).max(200),
  TopicArn: sesFeedbackTopicArnSchema,
  Timestamp: z.string().datetime(),
  SignatureVersion: z.enum(["1", "2"]),
  Signature: z.string().min(1).max(8192),
  SigningCertURL: z.string().url(),
  Subject: z.string().max(1000).optional(),
  SubscribeURL: z.string().url().optional(),
  Token: z.string().max(4096).optional(),
});
const awsFetch = createOutboundHttpClient({
  maxResponseBytes: 64 * 1024,
  maxRedirects: 0,
  timeoutMs: 10_000,
});

export async function verifySesFeedback(
  raw: unknown,
  topicArn: string,
  fetcher: typeof fetch = awsFetch,
) {
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success || parsed.data.TopicArn !== topicArn)
    throw new ProviderWebhookVerificationError();
  const message = parsed.data;
  const host = `sns.${topicArn.split(":")[3] ?? ""}.amazonaws.com`;
  const certUrl = new URL(message.SigningCertURL);
  if (
    certUrl.protocol !== "https:" ||
    certUrl.hostname !== host ||
    certUrl.port !== "" ||
    certUrl.username !== "" ||
    certUrl.password !== "" ||
    certUrl.search !== "" ||
    certUrl.hash !== "" ||
    !/^\/SimpleNotificationService-[A-Za-z0-9_-]+\.pem$/u.test(certUrl.pathname)
  )
    throw new ProviderWebhookVerificationError();
  const fields: readonly (keyof typeof message)[] =
    message.Type === "Notification"
      ? ([
          "Message",
          "MessageId",
          ...(message.Subject === undefined ? [] : (["Subject"] as const)),
          "Timestamp",
          "TopicArn",
          "Type",
        ] as const)
      : ([
          "Message",
          "MessageId",
          "SubscribeURL",
          "Timestamp",
          "Token",
          "TopicArn",
          "Type",
        ] as const);
  const canonical = fields.map((key) => `${key}\n${message[key] ?? ""}\n`).join("");
  if (
    message.Type === "SubscriptionConfirmation" &&
    (message.SubscribeURL === undefined || message.Token === undefined)
  )
    throw new ProviderWebhookVerificationError();
  const response = await fetcher(certUrl, { redirect: "error" });
  if (!response.ok)
    throw new Error("SNS signing certificate could not be retrieved; retry delivery.");
  const pem = await response.text();
  if (Buffer.byteLength(pem) > 64 * 1024) throw new ProviderWebhookVerificationError();
  let valid = false;
  try {
    const cert = new X509Certificate(pem);
    const now = Date.now();
    valid =
      Date.parse(cert.validFrom) <= now &&
      Date.parse(cert.validTo) > now &&
      cert.publicKey.asymmetricKeyType === "rsa" &&
      verify(
        message.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1",
        Buffer.from(canonical),
        cert.publicKey,
        Buffer.from(message.Signature, "base64"),
      );
  } catch {
    /* Invalid certificates and signatures fail closed. */
  }
  if (!valid) throw new ProviderWebhookVerificationError();
  if (message.Type === "SubscriptionConfirmation") {
    const url = new URL(message.SubscribeURL ?? "");
    if (
      url.protocol !== "https:" ||
      url.hostname !== host ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.hash !== "" ||
      url.searchParams.get("Action") !== "ConfirmSubscription" ||
      url.searchParams.get("TopicArn") !== topicArn ||
      url.searchParams.get("Token") !== message.Token
    )
      throw new ProviderWebhookVerificationError();
    const confirmation = await fetcher(url, { redirect: "error" });
    if (!confirmation.ok)
      throw new Error("SNS subscription could not be confirmed; retry delivery.");
    return { subscriptionConfirmed: true, events: [] } as const;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(message.Message);
  } catch {
    throw new ProviderWebhookPayloadError("SES notification is not JSON.");
  }
  return {
    subscriptionConfirmed: false,
    events: normalizeSesFeedback(payload, message.MessageId),
  } as const;
}

const recipientSchema = z.object({ emailAddress: z.string().email().max(320) });
const feedbackSchema = z.object({
  notificationType: z.string().optional(),
  eventType: z.string().optional(),
  mail: z.object({
    messageId: z.string().min(1).max(1000),
    headers: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .max(200)
      .optional(),
  }),
  bounce: z
    .object({
      timestamp: z.string().datetime(),
      bounceType: z.string(),
      bouncedRecipients: z.array(recipientSchema).min(1).max(1000),
    })
    .optional(),
  complaint: z
    .object({
      timestamp: z.string().datetime(),
      complainedRecipients: z.array(recipientSchema).min(1).max(1000),
    })
    .optional(),
  delivery: z
    .object({
      timestamp: z.string().datetime(),
      recipients: z.array(z.string().email().max(320)).min(1).max(1000),
    })
    .optional(),
  deliveryDelay: z
    .object({
      timestamp: z.string().datetime(),
      delayedRecipients: z.array(recipientSchema).min(1).max(1000),
    })
    .optional(),
});

export function normalizeSesFeedback(
  raw: unknown,
  notificationId: string,
): readonly NormalizedMailDeliveryEvent[] {
  const parsed = feedbackSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderWebhookPayloadError("Invalid SES feedback payload.");
  const value = parsed.data;
  const kind = value.notificationType ?? value.eventType;
  let timestamp: string;
  let recipients: readonly string[];
  let type: NormalizedMailDeliveryEvent["type"];
  if (kind === "Bounce" && value.bounce) {
    timestamp = value.bounce.timestamp;
    recipients = value.bounce.bouncedRecipients.map((item) => item.emailAddress);
    type = value.bounce.bounceType === "Permanent" ? "hard_bounce" : "soft_bounce";
  } else if (kind === "Complaint" && value.complaint) {
    timestamp = value.complaint.timestamp;
    recipients = value.complaint.complainedRecipients.map((item) => item.emailAddress);
    type = "complaint";
  } else if (kind === "Delivery" && value.delivery) {
    timestamp = value.delivery.timestamp;
    recipients = value.delivery.recipients;
    type = "delivered";
  } else if (kind === "DeliveryDelay" && value.deliveryDelay) {
    timestamp = value.deliveryDelay.timestamp;
    recipients = value.deliveryDelay.delayedRecipients.map((item) => item.emailAddress);
    type = "delayed";
  } else throw new ProviderWebhookPayloadError("Unsupported or incomplete SES feedback event.");
  const handoff = z
    .string()
    .uuid()
    .safeParse(
      value.mail.headers?.find((header) => header.name.toLowerCase() === "x-helix-idempotency-key")
        ?.value,
    );
  return [...new Set(recipients.map((recipient) => recipient.toLowerCase()))].map((recipient) => ({
    providerEventId: `${notificationId}:${recipient}`,
    providerMessageId: value.mail.messageId,
    ...(handoff.success ? { handoffKey: handoff.data } : {}),
    recipient,
    type,
    occurredAt: new Date(timestamp),
    metadata: { provider: "ses" },
  }));
}
