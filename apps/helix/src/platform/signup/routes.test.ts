import fastify from "fastify";
import type { Actor } from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { unauthenticatedActor } from "../../api/actor.js";
import {
  registerInviteRoutes,
  buildSignupOnboardingInviteUrl,
  buildSignupVerificationUrl,
} from "./routes.js";

type Dependencies = Parameters<typeof registerInviteRoutes>[1];
const actor: Actor = {
  type: "user",
  id: "actor-1",
  orgId: "org-1",
  email: "member@example.test",
  scopes: ["admin.users"],
};
const org = {
  id: "org-1",
  slug: "acme",
  displayName: "Acme",
  status: "active",
  region: "default",
  tier: "business",
  planId: "business",
  byoConfig: {},
  featureFlags: {},
  quotas: {},
  branding: {},
  suspendedAt: null,
  softDeletedAt: null,
  hardDeletedAt: null,
} as const;
function dependencies(): Dependencies {
  return {
    orgs: {
      findById: vi.fn<Dependencies["orgs"]["findById"]>(),
      activateProvisionedOrg: vi.fn<Dependencies["orgs"]["activateProvisionedOrg"]>(),
    },
    provisioning: {
      findByOrgId: vi.fn<Dependencies["provisioning"]["findByOrgId"]>(),
      markSucceeded: vi.fn<Dependencies["provisioning"]["markSucceeded"]>(),
    },
    verificationTokens: {
      issue: vi.fn<Dependencies["verificationTokens"]["issue"]>(),
      findValid: vi.fn<Dependencies["verificationTokens"]["findValid"]>().mockResolvedValue(null),
      consume: vi.fn<Dependencies["verificationTokens"]["consume"]>().mockResolvedValue(null),
      reissueFromToken: vi
        .fn<Dependencies["verificationTokens"]["reissueFromToken"]>()
        .mockResolvedValue({ status: "not_found" }),
    },
    identities: {
      createVerifiedCredentialUser:
        vi.fn<Dependencies["identities"]["createVerifiedCredentialUser"]>(),
    },
    outbox: { insert: vi.fn<Dependencies["outbox"]["insert"]>() },
    publicBaseUrl: "https://helix.example.test",
    actorFromRequest: () => actor,
    onboardingInvites: {
      issue: vi.fn<Dependencies["onboardingInvites"]["issue"]>(),
      accept: vi
        .fn<Dependencies["onboardingInvites"]["accept"]>()
        .mockResolvedValue({ status: "not_found" }),
    },
  };
}

describe("invite-only account routes", () => {
  it("returns 404 for public signup and removed SaaS onboarding endpoints", async () => {
    const app = fastify();
    await registerInviteRoutes(app, dependencies());
    for (const [method, url] of [
      ["GET", "/signup"],
      ["POST", "/api/signup"],
      ["GET", "/api/signup/org-slug/acme/availability"],
      ["POST", "/api/signup/form-viewed"],
      ["GET", "/api/signup/onboarding-state"],
      ["POST", "/api/signup/onboarding-progress"],
      ["POST", "/api/signup/onboarding-event"],
      ["POST", "/api/signup/welcome-event"],
    ] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
    await app.close();
  });

  it("requires authentication and admin scope before creating invitation tokens", async () => {
    for (const [currentActor, statusCode] of [
      [unauthenticatedActor, 401],
      [{ ...actor, scopes: [] }, 403],
    ] as const) {
      const options = { ...dependencies(), actorFromRequest: () => currentActor };
      const app = fastify();
      await registerInviteRoutes(app, options);
      const response = await app.inject({
        method: "POST",
        url: "/api/signup/onboarding-invites",
        payload: { emails: ["invitee@example.test"] },
      });
      expect(response.statusCode).toBe(statusCode);
      expect(options.onboardingInvites.issue).not.toHaveBeenCalled();
      await app.close();
    }
  });

  it("rejects invalid, mismatched and expired invitation tokens without granting access", async () => {
    const options = dependencies();
    const app = fastify();
    await registerInviteRoutes(app, options);
    const invalid = await app.inject({
      method: "POST",
      url: "/api/signup/onboarding-invite/accept",
      payload: { token: "" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(options.onboardingInvites.accept).not.toHaveBeenCalled();
    for (const [status, code] of [
      ["not_found", 400],
      ["email_mismatch", 403],
    ] as const) {
      vi.mocked(options.onboardingInvites.accept).mockResolvedValueOnce({ status });
      const response = await app.inject({
        method: "POST",
        url: "/api/signup/onboarding-invite/accept",
        payload: { token: "invite-token" },
      });
      expect(response.statusCode).toBe(code);
    }
    expect(options.orgs.findById).not.toHaveBeenCalled();
    expect(options.outbox.insert).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects expired verification tokens before consuming or activating an identity", async () => {
    const options = dependencies();
    const app = fastify();
    await registerInviteRoutes(app, options);
    const response = await app.inject({
      method: "POST",
      url: "/api/signup/verify-email",
      payload: { token: "expired" },
    });
    expect(response.statusCode).toBe(400);
    expect(options.verificationTokens.consume).not.toHaveBeenCalled();
    expect(options.identities.createVerifiedCredentialUser).not.toHaveBeenCalled();
    expect(options.orgs.activateProvisionedOrg).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not disclose whether a resend token exists and preserves rate limits", async () => {
    const options = dependencies();
    const app = fastify();
    await registerInviteRoutes(app, options);
    const missing = await app.inject({
      method: "POST",
      url: "/api/signup/resend-verification",
      payload: { token: "missing" },
    });
    expect(missing.statusCode).toBe(202);
    expect(options.outbox.insert).not.toHaveBeenCalled();
    vi.mocked(options.verificationTokens.reissueFromToken).mockResolvedValueOnce({
      status: "rate_limited",
      retryAfterSeconds: 60,
    });
    const limited = await app.inject({
      method: "POST",
      url: "/api/signup/resend-verification",
      payload: { token: "token" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    await app.close();
  });

  it("accepts the matching invitation and redirects to the existing workspace", async () => {
    const options = dependencies();
    const invite = {
      orgId: org.id,
      invitedByActorId: "admin-1",
      email: "member@example.test",
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: new Date(),
      acceptedByActorId: actor.id,
      metadata: {},
    };
    vi.mocked(options.onboardingInvites.accept).mockResolvedValue({ status: "accepted", invite });
    vi.mocked(options.orgs.findById).mockResolvedValue(org);
    const app = fastify();
    await registerInviteRoutes(app, options);
    const response = await app.inject({
      method: "POST",
      url: "/api/signup/onboarding-invite/accept",
      payload: { token: "valid-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "accepted",
      org: { id: org.id },
      workspace: { workspaceUrl: "https://helix.example.test/mail" },
    });
    expect(options.onboardingInvites.accept).toHaveBeenCalledWith({ token: "valid-token", actor });
    expect(options.outbox.insert).toHaveBeenCalledOnce();
    await app.close();
  });

  it("verifies only a provisioned token and preserves identity, audit, and session activation", async () => {
    const options = dependencies();
    const token = {
      orgId: org.id,
      email: "owner@example.test",
      passwordHash: "hash",
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      metadata: {},
    };
    const provisioning = {
      orgId: org.id,
      status: "waiting_for_verification",
      requestedOwnerEmail: token.email,
      currentStep: "waiting_for_verification",
      completedSteps: ["created"],
      attemptCount: 1,
      lastError: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    } as const;
    vi.mocked(options.verificationTokens.findValid).mockResolvedValue(token);
    vi.mocked(options.verificationTokens.consume).mockResolvedValue(token);
    vi.mocked(options.provisioning.findByOrgId).mockResolvedValue(provisioning);
    vi.mocked(options.provisioning.markSucceeded).mockResolvedValue({
      ...provisioning,
      status: "succeeded",
      completedAt: new Date(),
    });
    vi.mocked(options.identities.createVerifiedCredentialUser).mockResolvedValue({
      actorId: actor.id,
      betterAuthUserId: "user-1",
    });
    vi.mocked(options.orgs.activateProvisionedOrg).mockResolvedValue(org);
    const app = fastify();
    await registerInviteRoutes(app, options);
    const response = await app.inject({
      method: "POST",
      url: "/api/signup/verify-email",
      payload: { token: "valid-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "active",
      session: { status: "credential_ready" },
      workspace: { workspaceUrl: "https://helix.example.test/mail" },
    });
    expect(options.identities.createVerifiedCredentialUser).toHaveBeenCalledWith({
      orgId: org.id,
      email: token.email,
      passwordHash: token.passwordHash,
    });
    expect(options.provisioning.markSucceeded).toHaveBeenCalledWith({
      orgId: org.id,
      currentStep: "email_verified",
      completedSteps: ["created", "email_verified"],
    });
    expect(options.outbox.insert).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "tenant.provisioned" }),
    );
    await app.close();
  });

  it("keeps invite and verification links on the configured workspace origin", () => {
    expect(
      buildSignupOnboardingInviteUrl("https://helix.example.test/base", "token with spaces"),
    ).toBe("https://helix.example.test/signup/invite?token=token+with+spaces");
    expect(buildSignupVerificationUrl("https://helix.example.test/base", "token with spaces")).toBe(
      "https://helix.example.test/signup/verify-email?token=token+with+spaces",
    );
  });
});
