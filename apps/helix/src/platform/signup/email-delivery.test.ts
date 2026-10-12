import { describe, expect, it } from "vitest";
import { InMemoryEventBus } from "../events/in-memory-event-bus.js";
import type { MailOutboundEnvelope } from "../mail/types.js";
import type { OutboundMailTransport } from "../mail/outbound.js";
import {
  parseSignupOnboardingInviteEmailPayload,
  parseSignupVerificationEmailPayload,
  renderSignupOnboardingInviteEmail,
  renderSignupVerificationEmail,
  signupOnboardingInviteEmailSubject,
  signupVerificationEmailSubject,
  SignupOnboardingInviteEmailWorker,
  SignupVerificationEmailWorker,
  type SignupOnboardingInviteEmailPayload,
  type SignupVerificationEmailPayload,
} from "./email-delivery.js";

describe("signup verification email delivery", () => {
  it("renders a verification email envelope from the outbox payload", () => {
    const envelope = renderSignupVerificationEmail({
      payload: payload(),
      from: { address: "no-reply@helix.example", name: "Helix" },
    });

    expect(envelope).toMatchObject({
      from: { address: "no-reply@helix.example", name: "Helix" },
      to: [{ address: "owner@example.com" }],
      subject: "Verify acme workspace",
      attachments: [],
    });
    expect(envelope.text).toContain("https://app.helix.example/signup/verify-email?token=token");
    expect(envelope.text).toContain("Welcome to Helix.");
    expect(envelope.html).toContain("Workspace verification");
    expect(envelope.html).toContain("Verify workspace");
  });

  it("sends signup verification events through the configured transport", async () => {
    const sent: MailOutboundEnvelope[] = [];
    const transport: OutboundMailTransport = {
      async send(envelope) {
        sent.push(envelope);
        return { providerMessageId: "message-1", deliveryMetadata: {} };
      },
    };
    const events = new InMemoryEventBus();
    const worker = new SignupVerificationEmailWorker({
      events,
      transport,
      from: { address: "signup@helix.example", name: "Helix" },
    });

    await worker.start();
    await events.publish(signupVerificationEmailSubject, payload());
    await worker.stop();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: { address: "signup@helix.example", name: "Helix" },
      to: [{ address: "owner@example.com" }],
      subject: "Verify acme workspace",
    });
  });

  it("rejects malformed payloads before sending", async () => {
    expect(() => parseSignupVerificationEmailPayload({ source: "signup" })).toThrow(
      "Invalid signup verification email payload.",
    );
  });
});

describe("signup onboarding invite email delivery", () => {
  it("renders one onboarding invite email envelope", () => {
    const envelope = renderSignupOnboardingInviteEmail({
      payload: invitePayload({ email: "ada@example.com" }),
      from: { address: "no-reply@helix.example", name: "Helix" },
    });

    expect(envelope).toMatchObject({
      from: { address: "no-reply@helix.example", name: "Helix" },
      to: [{ address: "ada@example.com" }],
      subject: "Join acme workspace on Helix",
      attachments: [],
    });
    expect(envelope.text).toContain("https://acme.helix.example/signup/invite?token=token");
    expect(envelope.text).toContain("sign in with email/password or your organization's SSO");
    expect(envelope.html).toContain("Workspace invitation");
    expect(envelope.html).toContain("Open acme workspace");
  });

  it("sends one onboarding invite email per delivery event", async () => {
    const sent: MailOutboundEnvelope[] = [];
    const transport: OutboundMailTransport = {
      async send(envelope) {
        sent.push(envelope);
        return { providerMessageId: `message-${String(sent.length)}`, deliveryMetadata: {} };
      },
    };
    const events = new InMemoryEventBus();
    const worker = new SignupOnboardingInviteEmailWorker({
      events,
      transport,
      from: { address: "signup@helix.example", name: "Helix" },
    });

    await worker.start();
    await events.publish(
      signupOnboardingInviteEmailSubject,
      invitePayload({ email: "ada@example.com" }),
    );
    await worker.stop();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to[0]?.address).toBe("ada@example.com");
    expect(sent[0]?.subject).toBe("Join acme workspace on Helix");
  });

  it("renders an administrator's invitation as account setup in the named workspace", () => {
    const envelope = renderSignupOnboardingInviteEmail({
      payload: adminInvitePayload(),
      from: { address: "no-reply@helix.example", name: "Helix" },
    });

    expect(envelope).toMatchObject({
      to: [{ address: "ada@example.com" }],
      subject: "Join Acme Corp on Helix",
      attachments: [],
    });
    expect(envelope.text).toContain("An administrator invited you to Acme Corp.");
    expect(envelope.text).toContain("choose your password");
    expect(envelope.text).toContain("https://acme.helix.example/signup/invite?token=token");
    expect(envelope.text).not.toContain("SSO");
    expect(envelope.html).toContain("Set up your account");
    expect(envelope.html).toContain("Join Acme Corp");
    expect(envelope.html).not.toContain("Open acme workspace");
  });

  it("delivers every administrator invitation, keyed by its delivery key", async () => {
    const sent: { envelope: MailOutboundEnvelope; idempotencyKey: string | undefined }[] = [];
    const transport: OutboundMailTransport = {
      async send(envelope, options) {
        sent.push({ envelope, idempotencyKey: options.idempotencyKey });
        return { providerMessageId: `message-${String(sent.length)}`, deliveryMetadata: {} };
      },
    };
    const events = new InMemoryEventBus();
    const worker = new SignupOnboardingInviteEmailWorker({
      events,
      transport,
      from: { address: "signup@helix.example", name: "Helix" },
    });

    await worker.start();
    await events.publish(signupOnboardingInviteEmailSubject, adminInvitePayload("key-1"));
    // A resend to the same person is a separate delivery.
    await events.publish(signupOnboardingInviteEmailSubject, adminInvitePayload("key-2"));
    await events.publish(signupOnboardingInviteEmailSubject, invitePayload());
    await worker.stop();

    expect(sent.map((entry) => entry.idempotencyKey)).toEqual([
      "admin-invite:11111111-1111-4111-8111-111111111111:key-1",
      "admin-invite:11111111-1111-4111-8111-111111111111:key-2",
      "signup-invite:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222",
    ]);
    expect(sent[0]?.envelope.subject).toBe("Join Acme Corp on Helix");
  });

  it("parses administrator invitation payloads and drops malformed optional fields", () => {
    expect(parseSignupOnboardingInviteEmailPayload(adminInvitePayload())).toEqual(
      adminInvitePayload(),
    );
    expect(
      parseSignupOnboardingInviteEmailPayload({
        ...adminInvitePayload(),
        deliveryKey: 42,
        workspaceName: null,
      }),
    ).toEqual({
      orgId: "11111111-1111-4111-8111-111111111111",
      orgSlug: "acme",
      actorId: "22222222-2222-4222-8222-222222222222",
      email: "ada@example.com",
      inviteUrl: "https://acme.helix.example/signup/invite?token=token",
      source: "admin",
    });
    expect(() =>
      parseSignupOnboardingInviteEmailPayload({ ...adminInvitePayload(), source: "other" }),
    ).toThrow("Invalid signup onboarding invite email payload.");
  });

  it("rejects malformed onboarding invite payloads before sending", () => {
    expect(() => parseSignupOnboardingInviteEmailPayload({ source: "signup" })).toThrow(
      "Invalid signup onboarding invite email payload.",
    );
  });
});

function payload(): SignupVerificationEmailPayload {
  return {
    orgId: "11111111-1111-4111-8111-111111111111",
    orgSlug: "acme",
    email: "owner@example.com",
    verificationUrl: "https://app.helix.example/signup/verify-email?token=token",
    expiresAt: "2026-05-25T00:00:00.000Z",
    source: "signup",
  };
}

function invitePayload(
  overrides: Partial<SignupOnboardingInviteEmailPayload> = {},
): SignupOnboardingInviteEmailPayload {
  return {
    orgId: overrides.orgId ?? "11111111-1111-4111-8111-111111111111",
    orgSlug: overrides.orgSlug ?? "acme",
    actorId: overrides.actorId ?? "22222222-2222-4222-8222-222222222222",
    email: overrides.email ?? "ada@example.com",
    inviteUrl: overrides.inviteUrl ?? "https://acme.helix.example/signup/invite?token=token",
    source: "signup",
  };
}

function adminInvitePayload(deliveryKey = "delivery-1"): SignupOnboardingInviteEmailPayload {
  return {
    ...invitePayload(),
    source: "admin",
    deliveryKey,
    workspaceName: "Acme Corp",
  };
}
