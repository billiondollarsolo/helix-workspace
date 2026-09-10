import { describe, expect, it, vi } from "vitest";
import {
  acceptSignupOnboardingInvite,
  resendSignupVerification,
  SignupApiError,
  verifySignupEmail,
  type SignupFetch,
} from "./api";

describe("signup api", () => {
  it("verifies an email token", async () => {
    const fetchImpl = vi.fn<SignupFetch>().mockResolvedValue(
      Response.json({
        status: "active",
        org: {
          id: "11111111-1111-4111-8111-111111111111",
          slug: "acme",
          displayName: "Acme",
          status: "active",
          region: "default",
        },
        verification: { status: "verified" },
        session: { created: true, status: "created" },
        workspace: {
          workspaceUrl: "https://acme.helix.example/mail",
        },
      }),
    );

    const result = await verifySignupEmail("token-1", fetchImpl);

    expect(result.session.created).toBe(true);
    expect(result.workspace.workspaceUrl).toBe("https://acme.helix.example/mail");
    expect(fetchImpl).toHaveBeenCalledWith("/v1/api/signup/verify-email", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "token-1" }),
    });
  });

  it("requests verification email resend with only the stale token", async () => {
    const fetchImpl = vi
      .fn<SignupFetch>()
      .mockResolvedValue(Response.json({ status: "accepted" }, { status: 202 }));

    const result = await resendSignupVerification("old-token", fetchImpl);

    expect(result).toEqual({ status: "accepted" });
    expect(fetchImpl).toHaveBeenCalledWith("/v1/api/signup/resend-verification", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "old-token" }),
    });
  });

  it("accepts onboarding invite tokens with the current session", async () => {
    const fetchImpl = vi.fn<SignupFetch>().mockResolvedValue(
      Response.json({
        status: "accepted",
        org: {
          id: "11111111-1111-4111-8111-111111111111",
          slug: "acme",
          displayName: "Acme",
          status: "active",
          region: "default",
        },
        actorId: "22222222-2222-4222-8222-222222222222",
        workspace: {
          workspaceUrl: "https://acme.helix.example/mail",
        },
      }),
    );

    const result = await acceptSignupOnboardingInvite("invite-token", fetchImpl);

    expect(result.status).toBe("accepted");
    expect(result.workspace.workspaceUrl).toBe("https://acme.helix.example/mail");
    expect(fetchImpl).toHaveBeenCalledWith("/v1/api/signup/onboarding-invite/accept", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "invite-token" }),
    });
  });

  it("surfaces nested backend errors", async () => {
    const fetchImpl = vi.fn<SignupFetch>().mockResolvedValue(
      Response.json(
        {
          error: {
            code: "org_slug_unavailable",
            message: "That organization slug is not available.",
          },
        },
        { status: 409 },
      ),
    );

    const promise = verifySignupEmail("token", fetchImpl);

    await expect(promise).rejects.toThrow("That organization slug is not available.");
    await expect(promise).rejects.toMatchObject({
      status: 409,
      code: "org_slug_unavailable",
    } satisfies Partial<SignupApiError>);
  });

  it("preserves retry metadata on rate-limit errors", async () => {
    const fetchImpl = vi.fn<SignupFetch>().mockResolvedValue(
      Response.json(
        {
          error: {
            code: "signup_rate_limited",
            message: "Too many signup attempts from this IP address.",
          },
        },
        { status: 429, headers: { "retry-after": "30" } },
      ),
    );

    await expect(verifySignupEmail("token", fetchImpl)).rejects.toMatchObject({
      status: 429,
      code: "signup_rate_limited",
      retryAfterSeconds: 30,
    } satisfies Partial<SignupApiError>);
  });
});
