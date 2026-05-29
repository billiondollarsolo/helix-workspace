import { describe, expect, it, vi } from "vitest";
import {
  acceptSignupOnboardingInvite,
  checkOrgSlugAvailability,
  recordSignupFormViewed,
  resendSignupVerification,
  SignupApiError,
  signupFormViewedInputFromBrowser,
  startSignup,
  verifySignupEmail,
  type SignupFetch,
} from "./api";

describe("signup api", () => {
  it("checks workspace slug availability", async () => {
    const fetchImpl = vi.fn<SignupFetch>().mockResolvedValue(
      Response.json({
        slug: "acme",
        valid: true,
        available: true,
      }),
    );

    const result = await checkOrgSlugAvailability("acme", fetchImpl);

    expect(result.available).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("/api/signup/org-slug/acme/availability", {
      method: "GET",
      credentials: "include",
    });
  });

  it("submits the public signup payload", async () => {
    const fetchImpl = vi.fn<SignupFetch>().mockResolvedValue(
      Response.json(
        {
          status: "provisioning",
          org: {
            id: "11111111-1111-4111-8111-111111111111",
            slug: "acme",
            displayName: "Acme",
            status: "provisioning",
            region: "default",
          },
          verification: {
            required: true,
            status: "pending",
            expiresAt: "2026-05-25T00:00:00.000Z",
          },
        },
        { status: 202 },
      ),
    );

    const result = await startSignup(
      {
        email: "owner@example.com",
        password: "correct-horse-battery-staple",
        orgName: "Acme",
        orgSlug: "acme",
        country: "US",
        phone: "+14155550100",
        marketingOptIn: true,
        termsAccepted: true,
        privacyAccepted: true,
        recaptchaToken: "captcha-token",
      },
      fetchImpl,
    );

    expect(result.org.slug).toBe("acme");
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
    expect(init?.body).toBe(
      JSON.stringify({
        email: "owner@example.com",
        password: "correct-horse-battery-staple",
        orgName: "Acme",
        orgSlug: "acme",
        country: "US",
        phone: "+14155550100",
        marketingOptIn: true,
        termsAccepted: true,
        privacyAccepted: true,
        recaptchaToken: "captcha-token",
      }),
    );
  });

  it("records signup form views with allowlisted attribution", async () => {
    const fetchImpl = vi
      .fn<SignupFetch>()
      .mockResolvedValue(Response.json({ status: "accepted" }, { status: 202 }));

    const input = signupFormViewedInputFromBrowser({
      search:
        "?utm_source=newsletter&utm_medium=email&utm_campaign=launch&utm_term=owner@example.com&gclid=click-id",
      referrer: "https://www.helix.example/pricing?email=owner@example.com",
    });

    await recordSignupFormViewed(input, fetchImpl);

    expect(input).toEqual({
      page: "signup",
      attribution: {
        utmSource: "newsletter",
        utmMedium: "email",
        utmCampaign: "launch",
        referrerOrigin: "https://www.helix.example",
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/signup/form-viewed", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  });

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
          onboardingUrl: "https://acme.helix.example/onboarding",
          welcomeUrl: "https://acme.helix.example/welcome",
        },
      }),
    );

    const result = await verifySignupEmail("token-1", fetchImpl);

    expect(result.session.created).toBe(true);
    expect(result.workspace.onboardingUrl).toBe("https://acme.helix.example/onboarding");
    expect(fetchImpl).toHaveBeenCalledWith("/api/signup/verify-email", {
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
    expect(fetchImpl).toHaveBeenCalledWith("/api/signup/resend-verification", {
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
          onboardingUrl: "https://acme.helix.example/onboarding",
          welcomeUrl: "https://acme.helix.example/welcome",
        },
      }),
    );

    const result = await acceptSignupOnboardingInvite("invite-token", fetchImpl);

    expect(result.status).toBe("accepted");
    expect(result.workspace.welcomeUrl).toBe("https://acme.helix.example/welcome");
    expect(fetchImpl).toHaveBeenCalledWith("/api/signup/onboarding-invite/accept", {
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

    const promise = startSignup(
      {
        email: "owner@example.com",
        password: "correct-horse-battery-staple",
        orgName: "Acme",
        orgSlug: "acme",
        country: "US",
        marketingOptIn: false,
        termsAccepted: true,
        privacyAccepted: true,
      },
      fetchImpl,
    );

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

    await expect(
      startSignup(
        {
          email: "owner@example.com",
          password: "correct-horse-battery-staple",
          orgName: "Acme",
          orgSlug: "acme",
          country: "US",
          marketingOptIn: false,
          termsAccepted: true,
          privacyAccepted: true,
        },
        fetchImpl,
      ),
    ).rejects.toMatchObject({
      status: 429,
      code: "signup_rate_limited",
      retryAfterSeconds: 30,
    } satisfies Partial<SignupApiError>);
  });
});
