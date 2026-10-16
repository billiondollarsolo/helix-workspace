import { sign } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createTestCertificateAuthority } from "../../test-support/tls-fixtures.js";
import { InMemoryMailDeliveryEventStore } from "./provider-delivery-events.js";
import { normalizeSesFeedback, verifySesFeedback } from "./ses-feedback.js";

const topic = "arn:aws:sns:us-east-2:123456789012:helix-feedback";
const authority = createTestCertificateAuthority();
const certificate = authority.issue(["sns.us-east-2.amazonaws.com"]);
afterAll(() => {
  authority.dispose();
});
const payload = {
  notificationType: "Bounce",
  mail: { messageId: "ses-message-1" },
  bounce: {
    timestamp: "2026-10-15T00:00:00Z",
    bounceType: "Permanent",
    bouncedRecipients: [{ emailAddress: "one@example.test" }, { emailAddress: "two@example.test" }],
  },
};
function envelope(
  type: "Notification" | "SubscriptionConfirmation" = "Notification",
  version: "1" | "2" = "2",
) {
  const Token = "confirmation-token";
  const SubscribeURL = `https://sns.us-east-2.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(topic)}&Token=${Token}`;
  const message = {
    Type: type,
    Message: JSON.stringify(payload),
    MessageId: "notification-1",
    Timestamp: new Date().toISOString(),
    TopicArn: topic,
    SignatureVersion: version,
    SigningCertURL: "https://sns.us-east-2.amazonaws.com/SimpleNotificationService-fixture.pem",
    ...(type === "Notification" ? { Subject: "SES feedback" } : { SubscribeURL, Token }),
  };
  const keys =
    type === "Notification"
      ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  const fields = message as Record<string, string>;
  return {
    ...message,
    Signature: sign(
      version === "2" ? "RSA-SHA256" : "RSA-SHA1",
      Buffer.from(keys.map((key) => `${key}\n${fields[key] ?? ""}\n`).join("")),
      certificate.privateKeyPem,
    ).toString("base64"),
  };
}
describe("SES SNS feedback", () => {
  it.each(["1", "2"] as const)(
    "verifies signature version %s and deduplicates multi-recipient suppression",
    async (version) => {
      const fetcher = vi.fn<typeof fetch>(async () => new Response(certificate.certificatePem));
      const result = await verifySesFeedback(envelope("Notification", version), topic, fetcher);
      expect(result.events).toHaveLength(2);
      const store = new InMemoryMailDeliveryEventStore();
      for (const event of result.events)
        expect(await store.ingestEvent({ orgId: "org", providerId: "ses", event })).toMatchObject({
          duplicate: false,
          suppressed: true,
        });
      for (const event of result.events)
        expect(await store.ingestEvent({ orgId: "org", providerId: "ses", event })).toMatchObject({
          duplicate: true,
        });
      expect(
        await store.findActiveSuppressions("org", ["one@example.test", "two@example.test"]),
      ).toHaveLength(2);
      expect(await store.findActiveSuppressions("foreign", ["one@example.test"])).toEqual([]);
    },
  );
  it("rejects wrong topics, SSRF certificates, altered signatures and unsigned confirmations", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(certificate.certificatePem));
    for (const changed of [
      { TopicArn: topic + "-foreign" },
      { SigningCertURL: "https://127.0.0.1/key.pem" },
      {
        SigningCertURL:
          "https://sns.us-east-2.amazonaws.com.evil.test/SimpleNotificationService-test.pem",
      },
      {
        SigningCertURL:
          "https://sns.us-east-2.amazonaws.com/SimpleNotificationService-test.pem?redirect=evil",
      },
    ])
      await expect(
        verifySesFeedback({ ...envelope(), ...changed }, topic, fetcher),
      ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      verifySesFeedback({ ...envelope(), Message: "altered" }, topic, fetcher),
    ).rejects.toThrow();
    await expect(
      verifySesFeedback(
        { ...envelope("SubscriptionConfirmation"), SubscribeURL: "https://127.0.0.1/confirm" },
        topic,
        fetcher,
      ),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("confirms only a signed subscription to the configured topic", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async (url) =>
        new Response(
          (url instanceof URL ? url.href : typeof url === "string" ? url : url.url).includes(".pem")
            ? certificate.certificatePem
            : "confirmed",
        ),
    );
    expect(await verifySesFeedback(envelope("SubscriptionConfirmation"), topic, fetcher)).toEqual({
      subscriptionConfirmed: true,
      events: [],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("normalizes delivery, temporary bounce, complaint and delay without storing raw headers", () => {
    const mail = {
      messageId: "ses-id",
      headers: [{ name: "X-Helix-Idempotency-Key", value: "12345678-1234-4234-8234-123456789012" }],
    };
    for (const [eventType, detail, type] of [
      [
        "Delivery",
        { delivery: { timestamp: "2026-10-15T00:00:00Z", recipients: ["one@example.test"] } },
        "delivered",
      ],
      ["Bounce", { bounce: { ...payload.bounce, bounceType: "Transient" } }, "soft_bounce"],
      [
        "Complaint",
        {
          complaint: {
            timestamp: "2026-10-15T00:00:00Z",
            complainedRecipients: [{ emailAddress: "one@example.test" }],
          },
        },
        "complaint",
      ],
      [
        "DeliveryDelay",
        {
          deliveryDelay: {
            timestamp: "2026-10-15T00:00:00Z",
            delayedRecipients: [{ emailAddress: "one@example.test" }],
          },
        },
        "delayed",
      ],
    ])
      expect(
        normalizeSesFeedback({ eventType, mail, ...(detail as object) }, "notification")[0],
      ).toMatchObject({ type, handoffKey: mail.headers[0]?.value, metadata: { provider: "ses" } });
  });
});
