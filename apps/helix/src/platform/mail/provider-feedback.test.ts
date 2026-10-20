import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signWebhookPayload } from "../webhooks/signatures.js";
import { verifyProviderFeedback } from "./provider-feedback.js";
import { managedSmtpDeliveryMessageId } from "./threading.js";

const now = Date.parse("2026-10-20T12:00:00Z");
const timestamp = String(now / 1000);
const recipient = "user@example.net";
describe("native provider feedback", () => {
  it("verifies SendGrid ECDSA over the original bytes, bounds replays, and keeps recipient event IDs", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const rawBody = Buffer.from(
      JSON.stringify([
        {
          event: "bounce",
          type: "bounce",
          email: recipient,
          timestamp: now / 1000,
          sg_event_id: "evt-1",
          "smtp-id": "<original@example.com>",
        },
        { event: "open" },
      ]),
    );
    const input = {
      kind: "sendgrid" as const,
      rawBody,
      secret: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      now,
      headers: {
        "x-twilio-email-event-webhook-timestamp": timestamp,
        "x-twilio-email-event-webhook-signature": sign(
          "sha256",
          Buffer.concat([Buffer.from(timestamp), rawBody]),
          privateKey,
        ).toString("base64"),
      },
    };
    expect(verifyProviderFeedback(input)).toMatchObject([
      { type: "hard_bounce", recipient, providerMessageId: "<original@example.com>" },
    ]);
    expect(() =>
      verifyProviderFeedback({ ...input, rawBody: Buffer.concat([rawBody, Buffer.from(" ")]) }),
    ).toThrow(/signature/u);
    expect(() => verifyProviderFeedback({ ...input, now: now + 301000 })).toThrow(/signature/u);
  });
  it("authenticates Resend Svix signatures and does not suppress a transient bounce", () => {
    const key = Buffer.from("test-key-only-for-feedback");
    const rawBody = Buffer.from(
      JSON.stringify({
        type: "email.bounced",
        created_at: new Date(now).toISOString(),
        data: { email_id: "email-1", to: [recipient], bounce: { type: "Transient" } },
      }),
    );
    const signature = createHmac("sha256", key)
      .update(`evt.${timestamp}.`)
      .update(rawBody)
      .digest("base64");
    const input = {
      kind: "resend" as const,
      rawBody,
      secret: `whsec_${key.toString("base64")}`,
      now,
      headers: {
        "svix-id": "evt",
        "svix-timestamp": timestamp,
        "svix-signature": `v1,${signature}`,
      },
    };
    expect(verifyProviderFeedback(input)).toMatchObject([
      { type: "soft_bounce", providerEventId: `evt:${recipient}` },
    ]);
    expect(() =>
      verifyProviderFeedback({ ...input, headers: { ...input.headers, "svix-id": "forged" } }),
    ).toThrow(/signature/u);
  });
  it("requires Postmark's dedicated HTTP credential and normalizes delivery and complaints", () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        RecordType: "SpamComplaint",
        ID: 123,
        MessageID: "email-1",
        Email: recipient,
        BouncedAt: new Date(now).toISOString(),
      }),
    );
    const input = {
      kind: "postmark" as const,
      rawBody,
      secret: "dedicated",
      headers: { authorization: `Basic ${Buffer.from("helix:dedicated").toString("base64")}` },
    };
    expect(verifyProviderFeedback(input)).toMatchObject([{ type: "complaint", recipient }]);
    expect(() => verifyProviderFeedback({ ...input, secret: "another-provider" })).toThrow(
      /signature/u,
    );
  });
  it("requires signed Cloudflare Queue bridge bytes and normalizes its message ID", () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        type: "cf.email.sending.message.delivered",
        payload: { eventId: "evt", messageId: "<id@example.com>", recipient },
        metadata: { eventTimestamp: new Date(now).toISOString() },
      }),
    );
    const header = signWebhookPayload({
      payload: rawBody,
      secret: "bridge-secret",
      timestamp: now,
    }).header;
    expect(
      verifyProviderFeedback({
        kind: "cloudflare",
        rawBody,
        secret: "bridge-secret",
        headers: { "x-helix-signature": header },
        now,
      }),
    ).toMatchObject([{ type: "delivered", providerMessageId: "id@example.com" }]);
  });
  it("extracts managed SMTP IDs without mistaking an ordinary success for an ID", () => {
    expect(
      managedSmtpDeliveryMessageId(
        { messageId: "original", response: "250 2.0.0 Ok <id@example.com>" },
        "smtp.mx.cloudflare.net",
      ),
    ).toBe("id@example.com");
    expect(
      managedSmtpDeliveryMessageId(
        { messageId: "original", response: "250 2.0.0 Ok" },
        "smtp.mx.cloudflare.net",
      ),
    ).toBe("original");
    expect(
      managedSmtpDeliveryMessageId(
        { messageId: "original", response: "250 3c09be3e-4129-4921-9f3d-03ba046ed120" },
        "smtp.resend.com",
      ),
    ).toBe("3c09be3e-4129-4921-9f3d-03ba046ed120");
  });
});
