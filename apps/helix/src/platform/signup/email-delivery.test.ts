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
