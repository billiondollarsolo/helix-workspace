import fastify from "fastify";
import type {
  Actor,
  JsonObject,
  MeteringClient,
  MeteringEvent,
  TraceContext,
} from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { unauthenticatedActor } from "../../api/actor.js";
import { createPlatformMetrics } from "../../api/metrics.js";
import type { CreateOrgInput } from "../tenancy/index.js";
import {
  buildSignupOnboardingInviteUrl,
  buildSignupVerificationUrl,
  buildSignupWorkspaceUrls,
  registerSignupRoutes,
  registerSignupRoutesForMode,
  shouldRegisterSignupRoutes,
} from "./routes.js";

describe("signup route mode gate", () => {
  it("registers signup routes only for multi-tenant SaaS mode", async () => {
    expect(shouldRegisterSignupRoutes({ mode: "single-tenant" })).toBe(false);
    expect(shouldRegisterSignupRoutes({ mode: "multi-tenant-saas" })).toBe(true);

    const singleTenantApp = fastify();
    await registerSignupRoutesForMode(singleTenantApp, { config: { mode: "single-tenant" } });
    const singleTenantResponse = await singleTenantApp.inject({
      method: "POST",
      url: "/api/signup",
      payload: validSignupBody(),
    });
    expect(singleTenantResponse.statusCode).toBe(404);
    const singleTenantSlugResponse = await singleTenantApp.inject({
      method: "GET",
      url: "/api/signup/org-slug/acme/availability",
    });
    expect(singleTenantSlugResponse.statusCode).toBe(404);
    await singleTenantApp.close();

    const saasApp = fastify();
    await expect(
      registerSignupRoutesForMode(saasApp, { config: { mode: "multi-tenant-saas" } }),
    ).rejects.toThrow(
      "SaaS signup cannot start without required dependencies: orgs, provisioning, verificationTokens, identities, outbox, abuse, ownerEmails, passwordScreener, riskReviewer, actorFromRequest, onboarding, onboardingInvites",
    );
    await saasApp.close();
  });
});

describe("signup route skeleton", () => {
  it("validates the public signup request shape before returning the provisioning placeholder", async () => {
    const app = fastify();
    await registerSignupRoutes(app);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: {
        email: "not-an-email",
        password: "short",
        orgName: "",
        orgSlug: "Bad Slug",
        country: "usa",
        termsAccepted: false,
        privacyAccepted: false,
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "bad_request" } });

    const valid = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: validSignupBody(),
    });
    expect(valid.statusCode).toBe(501);
    expect(valid.json()).toMatchObject({
      error: {
        code: "signup_not_implemented",
        details: { phase: "platform-v2.A.8", route: "/api/signup" },
      },
    });
    await app.close();
  });

  it("starts org provisioning when a signup org store is configured", async () => {
    const app = fastify();
    const created: unknown[] = [];
    const provisioning: unknown[] = [];
    await registerSignupRoutes(app, {
      orgs: {
        async createOrg(input) {
          created.push(input);
          return {
            id: "11111111-1111-4111-8111-111111111111",
            slug: input.slug,
            displayName: input.displayName,
            status: input.status ?? "provisioning",
            tier: input.tier ?? "personal",
            planId: input.planId ?? "personal",
            region: input.region ?? "default",
            byoConfig: input.byoConfig ?? {},
            featureFlags: input.featureFlags ?? {},
            quotas: input.quotas ?? {},
            branding: input.branding ?? {},
            suspendedAt: null,
            softDeletedAt: null,
            hardDeletedAt: null,
          };
        },
      },
      provisioning: {
        async start(input) {
          provisioning.push(input);
          return {
            orgId: input.orgId,
            status: "pending",
            requestedOwnerEmail: input.requestedOwnerEmail,
            currentStep: input.currentStep ?? "signup_received",
            completedSteps: [],
            attemptCount: 0,
            lastError: null,
            metadata: input.metadata ?? {},
            createdAt: new Date("2026-05-24T00:00:00.000Z"),
            updatedAt: new Date("2026-05-24T00:00:00.000Z"),
            completedAt: null,
          };
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: validSignupBody(),
    });

    expect(response.statusCode).toBe(202);
    expect(created).toEqual([
      {
        slug: "acme",
        displayName: "Acme",
        status: "provisioning",
        tier: "personal",
        planId: "personal",
        region: "default",
      },
    ]);
    expect(provisioning).toEqual([
      {
        orgId: "11111111-1111-4111-8111-111111111111",
        requestedOwnerEmail: "owner@example.com",
        currentStep: "signup_received",
        metadata: {
          source: "signup",
          orgSlug: "acme",
          country: "US",
          marketingOptIn: false,
          policies: {
            termsAccepted: true,
            privacyAccepted: true,
          },
        },
      },
    ]);
    expect(response.json()).toEqual({
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
      },
    });
    await app.close();
  });

  it("checks organization slug availability for the signup form", async () => {
    const app = fastify();
    const checked: string[] = [];
    await registerSignupRoutes(app, {
      orgs: {
        ...createSignupOrgStore(),
        async findBySlug(slug) {
          checked.push(slug);
          return slug === "taken" ? signupOrg({ slug }) : null;
        },
      },
    });

    const available = await app.inject({
      method: "GET",
      url: "/api/signup/org-slug/acme/availability",
    });
    const taken = await app.inject({
      method: "GET",
      url: "/api/signup/org-slug/taken/availability",
    });
    const reserved = await app.inject({
      method: "GET",
      url: "/api/signup/org-slug/admin/availability",
    });
    const invalid = await app.inject({
      method: "GET",
      url: "/api/signup/org-slug/a-/availability",
    });

    expect(available.statusCode).toBe(200);
    expect(available.json()).toEqual({ slug: "acme", valid: true, available: true });
    expect(taken.statusCode).toBe(200);
    expect(taken.json()).toEqual({
      slug: "taken",
      valid: true,
      available: false,
      reason: "taken",
    });
    expect(reserved.statusCode).toBe(200);
    expect(reserved.json()).toEqual({
      slug: "admin",
      valid: false,
      available: false,
      reason: "reserved",
    });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json()).toEqual({
      slug: "a-",
      valid: false,
      available: false,
      reason: "invalid_format",
    });
    expect(checked).toEqual(["acme", "taken"]);
    await app.close();
  });

  it("returns a placeholder when slug availability storage is not configured", async () => {
    const app = fastify();
    await registerSignupRoutes(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/signup/org-slug/acme/availability",
    });

    expect(response.statusCode).toBe(501);
    expect(response.json()).toMatchObject({
      error: {
        code: "signup_slug_check_not_implemented",
        details: { phase: "commercial.B.4", route: "/api/signup/org-slug/:slug/availability" },
      },
    });
    await app.close();
  });

  it("issues a signup email verification token when a token store is configured", async () => {
    const app = fastify();
    const issued: unknown[] = [];
    const outbox: unknown[] = [];
    const metrics = createPlatformMetrics();
    await registerSignupRoutes(app, {
      orgs: createSignupOrgStore(),
      verificationTokens: {
        async issue(input) {
          issued.push(input);
          return {
            orgId: input.orgId,
            email: input.email.toLowerCase(),
            passwordHash: "stored-password-hash",
            token: "raw-token-not-returned",
            expiresAt: new Date("2026-05-25T00:00:00.000Z"),
            consumedAt: null,
            metadata: input.metadata ?? {},
          };
        },
        async findValid() {
          return null;
        },
        async consume() {
          return null;
        },
      },
      outbox: {
        async insert(message) {
          outbox.push(message);
          return "outbox-signup-email";
        },
      },
      metrics,
      publicBaseUrl: "https://app.helix.example/base",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: validSignupBody(),
    });

    expect(response.statusCode).toBe(202);
    expect(issued).toEqual([
      {
        orgId: "11111111-1111-4111-8111-111111111111",
        email: "owner@example.com",
        password: "correct-horse-battery-staple",
        metadata: {
          source: "signup",
          orgSlug: "acme",
          country: "US",
          marketingOptIn: false,
          policies: {
            termsAccepted: true,
            privacyAccepted: true,
          },
        },
      },
    ]);
    expect(response.json()).toMatchObject({
      verification: {
        required: true,
        status: "pending",
        expiresAt: "2026-05-25T00:00:00.000Z",
      },
    });
    expect(outbox).toEqual([
      {
        subject: "signup.form_submitted",
        payload: {
          orgId: "11111111-1111-4111-8111-111111111111",
          orgSlug: "acme",
          tier: "personal",
          planId: "personal",
          region: "default",
          step: "form_submitted",
          source: "signup",
        },
      },
      {
        subject: "signup.verification_email.send",
        payload: {
          orgId: "11111111-1111-4111-8111-111111111111",
          orgSlug: "acme",
          email: "owner@example.com",
          verificationUrl:
            "https://app.helix.example/signup/verify-email?token=raw-token-not-returned",
          expiresAt: "2026-05-25T00:00:00.000Z",
          source: "signup",
        },
      },
      {
        subject: "signup.verification_sent",
        payload: {
          orgId: "11111111-1111-4111-8111-111111111111",
          orgSlug: "acme",
          tier: "personal",
          planId: "personal",
          region: "default",
          step: "verification_sent",
          source: "signup",
          expiresAt: "2026-05-25T00:00:00.000Z",
        },
      },
    ]);
    expect(JSON.stringify(response.json())).not.toContain("raw-token-not-returned");
    expect(JSON.stringify(outbox)).not.toContain("correct-horse-battery-staple");
    expect(JSON.stringify(signupFunnelMessages(outbox))).not.toContain("owner@example.com");
    expect(JSON.stringify(signupFunnelMessages(outbox))).not.toContain("raw-token-not-returned");
    expect(JSON.stringify(signupFunnelMessages(outbox))).not.toContain("verificationUrl");
    const metricOutput = await metrics.registry.metrics();
    expect(metricOutput).toContain(
      'helix_signup_funnel_events_total{step="form_submitted",tier="personal",plan_id="personal",region="default"} 1',
    );
    expect(metricOutput).toContain(
      'helix_signup_funnel_events_total{step="verification_sent",tier="personal",plan_id="personal",region="default"} 1',
    );
    expect(metricOutput).not.toContain("owner@example.com");
    expect(metricOutput).not.toContain("raw-token-not-returned");
    await app.close();
  });

  it("emits no-PII signup form-viewed funnel telemetry", async () => {
    const app = fastify();
    const outbox: unknown[] = [];
    const metrics = createPlatformMetrics();
    await registerSignupRoutes(app, {
      outbox: {
        async insert(message) {
          outbox.push(message);
          return "outbox-form-viewed";
        },
      },
      metrics,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup/form-viewed",
      payload: {
        page: "signup",
        attribution: {
          utmSource: "newsletter",
          utmMedium: "email",
          utmCampaign: "launch",
          utmTerm: "workspace",
          utmContent: "cta",
          referrerOrigin: "https://www.helix.example",
        },
      },
      headers: {
        authorization: "Bearer should-not-leak",
        cookie: "helix_session=should-not-leak",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "accepted" });
    expect(outbox).toEqual([
      {
        subject: "signup.form_viewed",
        payload: {
          step: "form_viewed",
          source: "signup",
          page: "signup",
          attribution: {
            utmSource: "newsletter",
            utmMedium: "email",
            utmCampaign: "launch",
            utmTerm: "workspace",
            utmContent: "cta",
            referrerOrigin: "https://www.helix.example",
          },
        },
      },
    ]);
    expect(JSON.stringify(outbox)).not.toContain("should-not-leak");
    expect(JSON.stringify(outbox)).not.toContain("owner@example.com");
    const metricOutput = await metrics.registry.metrics();
    expect(metricOutput).toContain(
      'helix_signup_funnel_events_total{step="form_viewed",tier="unknown",plan_id="unknown",region="unknown"} 1',
    );
    expect(metricOutput).not.toContain("should-not-leak");
    expect(metricOutput).not.toContain("owner@example.com");
    await app.close();
  });

  it("rejects signup form-viewed telemetry that carries PII-like values", async () => {
    const app = fastify();
    const outbox: unknown[] = [];
    await registerSignupRoutes(app, {
      outbox: {
        async insert(message) {
          outbox.push(message);
          return "outbox-form-viewed";
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup/form-viewed",
      payload: {
        page: "signup",
        attribution: {
          utmCampaign: "owner@example.com",
          gclid: "must-not-be-accepted",
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "bad_request" } });
    expect(outbox).toEqual([]);
    await app.close();
  });

  it("requires outbox wiring for signup form-viewed telemetry", async () => {
    const app = fastify();
    await registerSignupRoutes(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/signup/form-viewed",
      payload: { page: "signup" },
    });

    expect(response.statusCode).toBe(501);
    expect(response.json()).toMatchObject({
      error: {
        code: "signup_form_viewed_telemetry_not_implemented",
        details: { phase: "commercial.B.4", route: "/api/signup/form-viewed" },
      },
    });
    await app.close();
  });

  it("builds verification links with encoded tokens", () => {
    expect(buildSignupVerificationUrl("https://app.helix.example", "token with spaces")).toBe(
      "https://app.helix.example/signup/verify-email?token=token+with+spaces",
    );
  });

  it("builds onboarding invite links without inheriting base subpaths", () => {
    expect(
      buildSignupOnboardingInviteUrl("https://app.helix.example/base", "acme", "token with spaces"),
    ).toBe("https://acme.helix.example/signup/invite?token=token+with+spaces");
  });

  it("builds tenant-scoped signup workspace links for subdomain smoke", () => {
    expect(buildSignupWorkspaceUrls("https://app.helix.example/base", "acme")).toEqual({
      onboardingUrl: "https://acme.helix.example/onboarding",
      welcomeUrl: "https://acme.helix.example/welcome",
    });
    expect(buildSignupWorkspaceUrls("https://www.helix.example/base", "acme")).toEqual({
      onboardingUrl: "https://acme.helix.example/onboarding",
      welcomeUrl: "https://acme.helix.example/welcome",
    });
    expect(buildSignupWorkspaceUrls("https://helix.example", "acme")).toEqual({
      onboardingUrl: "https://acme.helix.example/onboarding",
      welcomeUrl: "https://acme.helix.example/welcome",
    });
    expect(buildSignupWorkspaceUrls("https://acme.helix.example/base", "acme")).toEqual({
      onboardingUrl: "https://acme.helix.example/onboarding",
      welcomeUrl: "https://acme.helix.example/welcome",
    });
    expect(buildSignupWorkspaceUrls("http://localhost:3000/base", "acme")).toEqual({
      onboardingUrl: "http://localhost:3000/onboarding",
      welcomeUrl: "http://localhost:3000/welcome",
    });
    expect(buildSignupWorkspaceUrls("http://127.0.0.1:3000/base", "acme")).toEqual({
      onboardingUrl: "http://127.0.0.1:3000/onboarding",
      welcomeUrl: "http://127.0.0.1:3000/welcome",
    });
    expect(buildSignupWorkspaceUrls("http://[::1]:3000/base", "acme")).toEqual({
      onboardingUrl: "http://[::1]:3000/onboarding",
      welcomeUrl: "http://[::1]:3000/welcome",
    });
  });

  it("returns a conflict when the requested org slug is unavailable", async () => {
    const app = fastify();
    await registerSignupRoutes(app, {
      orgs: {
        async createOrg() {
          throw Object.assign(new Error("duplicate key value violates unique constraint"), {
            code: "23505",
          });
        },
      },
      publicBaseUrl: "https://app.helix.example/base",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: validSignupBody(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "org_slug_unavailable",
      },
    });
    await app.close();
  });

  it("rejects signup attempts blocked by the anti-abuse guard", async () => {
    const app = fastify();
    let createCalls = 0;
    await registerSignupRoutes(app, {
      orgs: {
        async createOrg() {
          createCalls += 1;
          throw new Error("createOrg should not run when signup abuse guard blocks");
        },
      },
      abuse: {
        async check(input) {
          expect(input).toMatchObject({
            email: "owner@example.com",
          });
          return {
            allowed: false,
            reason: "rate_limited",
            retryAfterSeconds: 30,
            limit: 5,
            windowSeconds: 3600,
          };
        },
      },
      riskReviewer: {
        async review() {
          throw new Error("risk reviewer should not run when abuse guard blocks");
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: validSignupBody(),
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("30");
    expect(response.json()).toMatchObject({
      error: {
        code: "signup_rate_limited",
        details: {
          retryAfterSeconds: 30,
          rateLimit: {
            reason: "signups_per_ip",
            limit: 5,
            windowSeconds: 3600,
          },
        },
      },
    });
    expect(createCalls).toBe(0);
    await app.close();
  });

  it("flags configured risky signups for manual review without blocking provisioning", async () => {
    const app = fastify();
    const provisioning: unknown[] = [];
    const outbox: unknown[] = [];
    await registerSignupRoutes(app, {
      orgs: createSignupOrgStore(),
      provisioning: {
        async start(input) {
          provisioning.push(input);
          return {
            orgId: input.orgId,
            status: "pending",
            requestedOwnerEmail: input.requestedOwnerEmail,
            currentStep: input.currentStep ?? "signup_received",
            completedSteps: [],
            attemptCount: 0,
            lastError: null,
            metadata: input.metadata ?? {},
            createdAt: new Date("2026-05-24T00:00:00.000Z"),
            updatedAt: new Date("2026-05-24T00:00:00.000Z"),
            completedAt: null,
          };
        },
      },
      riskReviewer: {
        async review(input) {
          expect(input).toEqual({
            country: "BR",
            phone: "+5511999999999",
          });
          return {
            required: true,
            country: "BR",
            reasons: ["configured_high_risk_country"],
            smsGuidance: "consider_sms_mfa_review",
          };
        },
      },
      outbox: {
        async insert(message) {
          outbox.push(message);
          return "outbox-risk";
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: validSignupBody({
        country: "BR",
        phone: "+5511999999999",
      }),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      status: "provisioning",
      verification: { status: "pending" },
    });
    expect(provisioning).toEqual([
      expect.objectContaining({
        orgId: "11111111-1111-4111-8111-111111111111",
        requestedOwnerEmail: "owner@example.com",
        currentStep: "signup_received",
        metadata: {
          source: "signup",
          orgSlug: "acme",
          country: "BR",
          phone: "+5511999999999",
          marketingOptIn: false,
          policies: {
            termsAccepted: true,
            privacyAccepted: true,
          },
          riskReview: {
            required: true,
            source: "signup_abuse_guard",
            country: "BR",
            reasons: ["configured_high_risk_country"],
            smsGuidance: "consider_sms_mfa_review",
          },
        },
      }),
    ]);
    expect(outbox).toEqual([
      {
        subject: "tenant.signup_risk_review.requested",
        payload: {
          orgId: "11111111-1111-4111-8111-111111111111",
          orgSlug: "acme",
          source: "signup",
          riskReview: {
            required: true,
            country: "BR",
            reasons: ["configured_high_risk_country"],
            smsGuidance: "consider_sms_mfa_review",
          },
        },
      },
      {
        subject: "signup.form_submitted",
        payload: {
          orgId: "11111111-1111-4111-8111-111111111111",
          orgSlug: "acme",
          tier: "personal",
          planId: "personal",
          region: "default",
          step: "form_submitted",
          source: "signup",
        },
      },
    ]);
    expect(JSON.stringify(outbox)).not.toContain("owner@example.com");
    expect(JSON.stringify(outbox)).not.toContain("+5511999999999");
    expect(JSON.stringify(outbox)).not.toContain("127.0.0.1");
    await app.close();
  });

  it("requires configured reCAPTCHA verification before creating a signup org", async () => {
    const app = fastify();
    let createCalls = 0;
    await registerSignupRoutes(app, {
      orgs: {
        async createOrg() {
          createCalls += 1;
          throw new Error("createOrg should not run when reCAPTCHA fails");
        },
      },
      recaptcha: {
        async verify(input) {
          expect(input.token).toBeUndefined();
          return { allowed: false, reason: "missing_token" };
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: validSignupBody(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "signup_recaptcha_failed",
        details: { reason: "missing_token" },
      },
    });
    expect(createCalls).toBe(0);
    await app.close();
  });

  it("passes signup reCAPTCHA tokens to the configured verifier", async () => {
    const app = fastify();
    const verified: unknown[] = [];
    await registerSignupRoutes(app, {
      orgs: createSignupOrgStore(),
      recaptcha: {
        async verify(input) {
          verified.push(input);
          return { allowed: true, score: 0.9, action: "signup" };
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: validSignupBody({ recaptchaToken: "captcha-token" }),
    });

    expect(response.statusCode).toBe(202);
    expect(verified).toEqual([
      {
        token: "captcha-token",
        ip: "127.0.0.1",
      },
    ]);
    await app.close();
  });

  it("fails closed when configured reCAPTCHA verification is unavailable", async () => {
    const app = fastify();
    let createCalls = 0;
    await registerSignupRoutes(app, {
      orgs: {
        async createOrg() {
          createCalls += 1;
          throw new Error("createOrg should not run when reCAPTCHA is unavailable");
        },
      },
      recaptcha: {
        async verify() {
          return { allowed: false, reason: "verification_unavailable" };
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: validSignupBody({ recaptchaToken: "captcha-token" }),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: "signup_recaptcha_unavailable",
      },
    });
    expect(createCalls).toBe(0);
    await app.close();
  });

  it("rejects disposable email domains before creating a signup org", async () => {
    const app = fastify();
    let createCalls = 0;
    await registerSignupRoutes(app, {
      orgs: {
        async createOrg() {
          createCalls += 1;
          throw new Error("createOrg should not run when email domain is blocked");
        },
      },
      abuse: {
        async check() {
          return {
            allowed: false,
            reason: "disposable_email_domain",
            domain: "mailinator.test",
          };
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: validSignupBody({ email: "owner@mailinator.test" }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "signup_email_domain_blocked",
        details: {
          reason: "disposable_email_domain",
        },
      },
    });
    expect(JSON.stringify(response.json())).not.toContain("mailinator.test");
    expect(createCalls).toBe(0);
    await app.close();
  });

  it("rejects owner emails already used by another tenant before creating a signup org", async () => {
    const app = fastify();
    let createCalls = 0;
    await registerSignupRoutes(app, {
      orgs: {
        async createOrg() {
          createCalls += 1;
          throw new Error("createOrg should not run for duplicate owner emails");
        },
      },
      ownerEmails: {
        async findOwnerByEmail(email) {
          expect(email).toBe("owner@example.com");
          return { orgId: "99999999-9999-4999-8999-999999999999", email: "owner@example.com" };
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: validSignupBody(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "signup_owner_email_unavailable",
      },
    });
    expect(JSON.stringify(response.json())).not.toContain("99999999-9999-4999-8999-999999999999");
    expect(createCalls).toBe(0);
    await app.close();
  });

  it("rejects weak signup passwords before creating a signup org", async () => {
    const app = fastify();
    let createCalls = 0;
    await registerSignupRoutes(app, {
      orgs: {
        async createOrg() {
          createCalls += 1;
          throw new Error("createOrg should not run for weak passwords");
        },
      },
      passwordScreener: {
        async check(input) {
          expect(input).toMatchObject({
            email: "owner@example.com",
            orgName: "Acme",
            password: "passwordpassword",
          });
          return { allowed: false, reason: "weak_password", score: 1, minScore: 3 };
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: validSignupBody({ password: "passwordpassword" }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "signup_password_weak",
        details: {
          score: 1,
          minScore: 3,
        },
      },
    });
    expect(createCalls).toBe(0);
    await app.close();
  });

  it("rejects breached signup passwords without disclosing breach counts", async () => {
    const app = fastify();
    let createCalls = 0;
    await registerSignupRoutes(app, {
      orgs: {
        async createOrg() {
          createCalls += 1;
          throw new Error("createOrg should not run for breached passwords");
        },
      },
      passwordScreener: {
        async check() {
          return { allowed: false, reason: "breached_password", breachCount: 12345 };
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: validSignupBody(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "signup_password_breached",
        details: {
          reason: "known_breach",
        },
      },
    });
    expect(JSON.stringify(response.json())).not.toContain("12345");
    expect(createCalls).toBe(0);
    await app.close();
  });

  it("fails closed when signup password screening is unavailable", async () => {
    const app = fastify();
    let createCalls = 0;
    await registerSignupRoutes(app, {
      orgs: {
        async createOrg() {
          createCalls += 1;
          throw new Error("createOrg should not run when password screening is unavailable");
        },
      },
      passwordScreener: {
        async check() {
          return { allowed: false, reason: "screening_unavailable" };
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: validSignupBody(),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: "signup_password_screening_unavailable",
      },
    });
    expect(createCalls).toBe(0);
    await app.close();
  });

  it("validates the email verification request shape before returning the placeholder", async () => {
    const app = fastify();
    await registerSignupRoutes(app);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/signup/verify-email",
      payload: {},
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "bad_request" } });

    const valid = await app.inject({
      method: "POST",
      url: "/api/signup/verify-email",
      payload: { token: "verify-token" },
    });
    expect(valid.statusCode).toBe(501);
    expect(valid.json()).toMatchObject({
      error: {
        code: "signup_verify_not_implemented",
        details: { phase: "platform-v2.A.8", route: "/api/signup/verify-email" },
      },
    });
    await app.close();
  });

  it("validates verification resend requests before returning the placeholder", async () => {
    const app = fastify();
    await registerSignupRoutes(app);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/signup/resend-verification",
      payload: {},
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "bad_request" } });

    const valid = await app.inject({
      method: "POST",
      url: "/api/signup/resend-verification",
      payload: { token: "old-token" },
    });
    expect(valid.statusCode).toBe(501);
    expect(valid.json()).toMatchObject({
      error: {
        code: "signup_verification_resend_not_implemented",
        details: { phase: "commercial.B.4", route: "/api/signup/resend-verification" },
      },
    });
    await app.close();
  });

  it("reissues verification email from a stale token without leaking secrets to funnel telemetry", async () => {
    const app = fastify();
    const outbox: unknown[] = [];
    await registerSignupRoutes(app, {
      verificationTokens: {
        async issue(input) {
          return {
            orgId: input.orgId,
            email: input.email,
            passwordHash: "stored-password-hash",
            token: "initial-token",
            expiresAt: new Date("2026-05-25T00:00:00.000Z"),
            consumedAt: null,
            metadata: input.metadata ?? {},
          };
        },
        async findValid() {
          return null;
        },
        async consume() {
          return null;
        },
        async reissueFromToken(input) {
          expect(input.token).toBe("old-token-not-returned");
          return {
            status: "issued",
            verification: {
              ...verificationRecord({
                expiresAt: new Date("2026-05-26T00:00:00.000Z"),
                metadata: { orgSlug: "acme", source: "signup" },
              }),
              token: "new-token-only-in-email",
            },
          };
        },
      },
      outbox: {
        async insert(message) {
          outbox.push(message);
          return "outbox-resend";
        },
      },
      publicBaseUrl: "https://app.helix.example/base",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup/resend-verification",
      payload: { token: "old-token-not-returned" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "accepted" });
    expect(outbox).toEqual([
      {
        subject: "signup.verification_email.send",
        payload: {
          orgId: "11111111-1111-4111-8111-111111111111",
          orgSlug: "acme",
          email: "owner@example.com",
          verificationUrl:
            "https://app.helix.example/signup/verify-email?token=new-token-only-in-email",
          expiresAt: "2026-05-26T00:00:00.000Z",
          source: "signup",
        },
      },
      {
        subject: "signup.verification_sent",
        payload: {
          orgId: "11111111-1111-4111-8111-111111111111",
          orgSlug: "acme",
          step: "verification_sent",
          source: "signup",
          resend: true,
          expiresAt: "2026-05-26T00:00:00.000Z",
        },
      },
    ]);
    expect(JSON.stringify(response.json())).not.toContain("old-token-not-returned");
    expect(JSON.stringify(response.json())).not.toContain("new-token-only-in-email");
    expect(JSON.stringify(outbox)).not.toContain("old-token-not-returned");
    expect(JSON.stringify(outbox)).not.toContain("stored-password-hash");
    expect(JSON.stringify(signupFunnelMessages(outbox))).not.toContain("owner@example.com");
    expect(JSON.stringify(signupFunnelMessages(outbox))).not.toContain("new-token-only-in-email");
    expect(JSON.stringify(signupFunnelMessages(outbox))).not.toContain("verificationUrl");
    await app.close();
  });

  it("returns a generic accepted response when verification resend cannot find a refreshable token", async () => {
    const app = fastify();
    const outbox: unknown[] = [];
    await registerSignupRoutes(app, {
      verificationTokens: {
        async issue(input) {
          return {
            orgId: input.orgId,
            email: input.email,
            passwordHash: "stored-password-hash",
            token: "initial-token",
            expiresAt: new Date("2026-05-25T00:00:00.000Z"),
            consumedAt: null,
            metadata: input.metadata ?? {},
          };
        },
        async findValid() {
          return null;
        },
        async consume() {
          return null;
        },
        async reissueFromToken() {
          return { status: "not_found" };
        },
      },
      outbox: {
        async insert(message) {
          outbox.push(message);
          return "outbox-resend";
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup/resend-verification",
      payload: { token: "unknown-or-consumed-token" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "accepted" });
    expect(outbox).toEqual([]);
    expect(JSON.stringify(response.json())).not.toContain("unknown-or-consumed-token");
    await app.close();
  });

  it("rate limits verification resend without writing outbox events", async () => {
    const app = fastify();
    const outbox: unknown[] = [];
    await registerSignupRoutes(app, {
      verificationTokens: {
        async issue(input) {
          return {
            orgId: input.orgId,
            email: input.email,
            passwordHash: "stored-password-hash",
            token: "initial-token",
            expiresAt: new Date("2026-05-25T00:00:00.000Z"),
            consumedAt: null,
            metadata: input.metadata ?? {},
          };
        },
        async findValid() {
          return null;
        },
        async consume() {
          return null;
        },
        async reissueFromToken() {
          return { status: "rate_limited", retryAfterSeconds: 3600 };
        },
      },
      outbox: {
        async insert(message) {
          outbox.push(message);
          return "outbox-resend";
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup/resend-verification",
      payload: { token: "old-token" },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("3600");
    expect(response.json()).toMatchObject({
      error: { code: "signup_verification_resend_rate_limited" },
    });
    expect(outbox).toEqual([]);
    await app.close();
  });

  it("requires auth and outbox wiring for onboarding telemetry", async () => {
    const app = fastify();
    await registerSignupRoutes(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/signup/onboarding-event",
      payload: { event: "started" },
    });

    expect(response.statusCode).toBe(501);
    expect(response.json()).toMatchObject({
      error: {
        code: "signup_onboarding_telemetry_not_implemented",
        details: { phase: "commercial.B.4", route: "/api/signup/onboarding-event" },
      },
    });
    await app.close();
  });

  it("rejects invalid onboarding telemetry without writing outbox events", async () => {
    const app = fastify();
    const outbox: unknown[] = [];
    await registerSignupRoutes(app, {
      actorFromRequest: () => testActor(),
      outbox: {
        async insert(message) {
          outbox.push(message);
          return "outbox-1";
        },
      },
      publicBaseUrl: "https://app.helix.example/base",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup/onboarding-event",
      payload: {
        event: "completed",
        inviteCount: 11,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "bad_request" } });
    expect(outbox).toEqual([]);
    await app.close();
  });

  it("rejects anonymous onboarding telemetry", async () => {
    const app = fastify();
    const outbox: unknown[] = [];
    await registerSignupRoutes(app, {
      actorFromRequest: () => unauthenticatedActor,
      outbox: {
        async insert(message) {
          outbox.push(message);
          return "outbox-1";
        },
      },
      publicBaseUrl: "https://app.helix.example/base",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup/onboarding-event",
      payload: { event: "started" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect(outbox).toEqual([]);
    await app.close();
  });

  it("returns authenticated onboarding recovery state without requiring outbox", async () => {
    const app = fastify();
    await registerSignupRoutes(app, {
      actorFromRequest: () => testActor(),
      onboarding: {
        async getState(orgId) {
          return {
            status: "in_progress",
            currentStep: "sso",
            planChoice: "personal",
            inviteCount: orgId === "11111111-1111-4111-8111-111111111111" ? 2 : 0,
            identityChoice: "google",
            updatedAt: "2026-05-24T12:00:00.000Z",
          };
        },
        async persistCompletion() {
          throw new Error("not used");
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/signup/onboarding-state",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "in_progress",
      currentStep: "sso",
      planChoice: "personal",
      inviteCount: 2,
      identityChoice: "google",
      updatedAt: "2026-05-24T12:00:00.000Z",
    });
    await app.close();
  });

  it("persists strict onboarding recovery progress without raw invite emails or outbox", async () => {
    const app = fastify();
    const persisted: unknown[] = [];
    await registerSignupRoutes(app, {
      actorFromRequest: () =>
        testActor({
          email: "owner@example.com",
          displayName: "Owner Example",
        }),
      onboarding: {
        async persistProgress(input) {
          persisted.push(input);
        },
        async persistCompletion() {
          throw new Error("not used");
        },
      },
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/signup/onboarding-progress",
      payload: {
        currentStep: "invite",
        planChoice: "pro-trial",
        inviteCount: 1,
        identityChoice: "local",
        inviteEmails: ["ada@example.com"],
      },
    });
    const valid = await app.inject({
      method: "POST",
      url: "/api/signup/onboarding-progress",
      payload: {
        currentStep: "invite",
        planChoice: "pro-trial",
        inviteCount: 1,
        identityChoice: "local",
      },
    });

    expect(invalid.statusCode).toBe(400);
    expect(valid.statusCode).toBe(202);
    expect(valid.json()).toEqual({ status: "accepted" });
    expect(persisted).toEqual([
      {
        orgId: "11111111-1111-4111-8111-111111111111",
        actorId: "22222222-2222-4222-8222-222222222222",
        currentStep: "invite",
        planChoice: "pro-trial",
        inviteCount: 1,
        identityChoice: "local",
      },
    ]);
    expect(JSON.stringify(persisted)).not.toContain("ada@example.com");
    expect(JSON.stringify(persisted)).not.toContain("owner@example.com");
    await app.close();
  });

  it("rejects onboarding SSO choices that are not available for the selected plan", async () => {
    const app = fastify();
    const persisted: unknown[] = [];
    const outbox: unknown[] = [];
    await registerSignupRoutes(app, {
      actorFromRequest: () =>
        testActor({
          email: "owner@example.com",
          displayName: "Owner Example",
        }),
      outbox: {
        async insert(message) {
          outbox.push(message);
          return "outbox-1";
        },
      },
      onboarding: {
        async persistProgress(input) {
          persisted.push(input);
        },
        async persistCompletion(input) {
          persisted.push(input);
        },
      },
    });

    const personalWithGoogle = await app.inject({
      method: "POST",
      url: "/api/signup/onboarding-progress",
      payload: {
        currentStep: "sso",
        planChoice: "personal",
        identityChoice: "google",
      },
    });
    const proWithSaml = await app.inject({
      method: "POST",
      url: "/api/signup/onboarding-event",
      payload: {
        event: "completed",
        planChoice: "pro-trial",
        inviteCount: 0,
        identityChoice: "saml",
      },
    });

    expect(personalWithGoogle.statusCode).toBe(400);
    expect(personalWithGoogle.json()).toMatchObject({
      error: { code: "bad_request" },
    });
    expect(proWithSaml.statusCode).toBe(400);
    expect(proWithSaml.json()).toMatchObject({
      error: { code: "bad_request" },
    });
    expect(persisted).toEqual([]);
    expect(outbox).toEqual([]);
    await app.close();
  });

  it("emits no-email onboarding funnel telemetry for authenticated signups", async () => {
    const app = fastify();
    const outbox: unknown[] = [];
    const persisted: unknown[] = [];
    const metrics = createPlatformMetrics();
    await registerSignupRoutes(app, {
      actorFromRequest: () =>
        testActor({
          email: "owner@example.com",
          displayName: "Owner Example",
        }),
      outbox: {
        async insert(message) {
          outbox.push(message);
          return "outbox-1";
        },
      },
      onboarding: {
        async persistCompletion(input) {
          persisted.push(input);
        },
      },
      metrics,
    });

    const started = await app.inject({
      method: "POST",
      url: "/api/signup/onboarding-event",
      payload: { event: "started" },
      headers: {
        authorization: "Bearer should-not-leak",
        cookie: "helix_session=should-not-leak",
      },
    });
    const completed = await app.inject({
      method: "POST",
      url: "/api/signup/onboarding-event",
      payload: {
        event: "completed",
        planChoice: "pro-trial",
        inviteCount: 2,
        identityChoice: "local",
        skipped: false,
      },
    });

    expect(started.statusCode).toBe(202);
    expect(started.json()).toEqual({ status: "accepted" });
    expect(completed.statusCode).toBe(202);
    expect(completed.json()).toEqual({ status: "accepted" });
    expect(outbox).toEqual([
      {
        subject: "signup.onboarding_started",
        payload: {
          orgId: "11111111-1111-4111-8111-111111111111",
          actorId: "22222222-2222-4222-8222-222222222222",
          source: "signup",
          step: "onboarding_started",
        },
      },
      {
        subject: "signup.onboarding_completed",
        payload: {
          orgId: "11111111-1111-4111-8111-111111111111",
          actorId: "22222222-2222-4222-8222-222222222222",
          source: "signup",
          step: "onboarding_completed",
          planChoice: "pro-trial",
          inviteCount: 2,
          identityChoice: "local",
          skipped: false,
        },
      },
    ]);
    expect(persisted).toEqual([
      {
        orgId: "11111111-1111-4111-8111-111111111111",
        actorId: "22222222-2222-4222-8222-222222222222",
        planChoice: "pro-trial",
        inviteCount: 2,
        identityChoice: "local",
        skipped: false,
      },
    ]);
    expect(JSON.stringify(outbox)).not.toContain("owner@example.com");
    expect(JSON.stringify(outbox)).not.toContain("Owner Example");
    expect(JSON.stringify(outbox)).not.toContain("should-not-leak");
    expect(JSON.stringify(persisted)).not.toContain("owner@example.com");
    const metricOutput = await metrics.registry.metrics();
    expect(metricOutput).toContain(
      'helix_signup_funnel_events_total{step="onboarding_started",tier="unknown",plan_id="unknown",region="unknown"} 1',
    );
    expect(metricOutput).toContain(
      'helix_signup_funnel_events_total{step="onboarding_completed",tier="unknown",plan_id="unknown",region="unknown"} 1',
    );
    expect(metricOutput).not.toContain("owner@example.com");
    expect(metricOutput).not.toContain("Owner Example");
    await app.close();
  });

  it("enqueues one onboarding invite delivery event per recipient", async () => {
    const app = fastify();
    const outbox: unknown[] = [];
    const issued: unknown[] = [];
    await registerSignupRoutes(app, {
      actorFromRequest: () =>
        testActor({
          email: "owner@example.com",
          displayName: "Owner Example",
          scopes: ["admin.*"],
        }),
      orgs: createSignupOrgStore(),
      onboardingInvites: {
        async issue(input) {
          issued.push(input);
          return {
            orgId: input.orgId,
            invitedByActorId: input.invitedByActorId,
            email: input.email,
            token: `invite-token-${input.email}`,
            expiresAt: new Date("2026-05-31T00:00:00.000Z"),
            acceptedAt: null,
            acceptedByActorId: null,
            metadata: input.metadata ?? {},
          };
        },
        async accept() {
          return { status: "not_found" };
        },
      },
      outbox: {
        async insert(message) {
          outbox.push(message);
          return "outbox-1";
        },
      },
      publicBaseUrl: "https://app.helix.example/base",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup/onboarding-invites",
      payload: { emails: [" Ada@Example.com ", "grace@example.com", "ada@example.com"] },
      headers: {
        authorization: "Bearer should-not-leak",
        cookie: "helix_session=should-not-leak",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "accepted", inviteCount: 2 });
    expect(issued).toEqual([
      {
        orgId: "11111111-1111-4111-8111-111111111111",
        invitedByActorId: "22222222-2222-4222-8222-222222222222",
        email: "ada@example.com",
        metadata: { source: "signup" },
      },
      {
        orgId: "11111111-1111-4111-8111-111111111111",
        invitedByActorId: "22222222-2222-4222-8222-222222222222",
        email: "grace@example.com",
        metadata: { source: "signup" },
      },
    ]);
    expect(outbox).toEqual([
      {
        subject: "signup.onboarding_invite_email.send",
        payload: {
          orgId: "11111111-1111-4111-8111-111111111111",
          orgSlug: "acme",
          actorId: "22222222-2222-4222-8222-222222222222",
          email: "ada@example.com",
          inviteUrl:
            "https://acme.helix.example/signup/invite?token=invite-token-ada%40example.com",
          source: "signup",
        },
      },
      {
        subject: "signup.onboarding_invite_email.send",
        payload: {
          orgId: "11111111-1111-4111-8111-111111111111",
          orgSlug: "acme",
          actorId: "22222222-2222-4222-8222-222222222222",
          email: "grace@example.com",
          inviteUrl:
            "https://acme.helix.example/signup/invite?token=invite-token-grace%40example.com",
          source: "signup",
        },
      },
    ]);
    expect(JSON.stringify(signupFunnelMessages(outbox))).not.toContain("ada@example.com");
    expect(JSON.stringify(signupFunnelMessages(outbox))).not.toContain("grace@example.com");
    expect(JSON.stringify(outbox)).not.toContain("owner@example.com");
    expect(JSON.stringify(outbox)).not.toContain("Owner Example");
    expect(JSON.stringify(outbox)).not.toContain("should-not-leak");
    expect(JSON.stringify(response.json())).not.toContain("invite-token");
    await app.close();
  });

  it("rejects invalid onboarding invite delivery requests", async () => {
    const app = fastify();
    const outbox: unknown[] = [];
    await registerSignupRoutes(app, {
      actorFromRequest: () => testActor(),
      outbox: {
        async insert(message) {
          outbox.push(message);
          return "outbox-1";
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup/onboarding-invites",
      payload: { emails: ["not-an-email"] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "bad_request" } });
    expect(outbox).toEqual([]);
    await app.close();
  });

  it("accepts an onboarding invite for the signed-in matching local account", async () => {
    const app = fastify();
    const accepted: unknown[] = [];
    const outbox: unknown[] = [];
    const metering: RecordedMeteringEvent[] = [];
    await registerSignupRoutes(app, {
      actorFromRequest: () =>
        testActor({
          email: "ada@example.com",
        }),
      orgs: createSignupOrgStore(),
      onboardingInvites: {
        async issue() {
          throw new Error("Invite acceptance should not issue a new invite.");
        },
        async accept(input) {
          accepted.push(input);
          return {
            status: "accepted",
            invite: {
              orgId: input.actor.orgId,
              invitedByActorId: "22222222-2222-4222-8222-222222222222",
              email: "ada@example.com",
              expiresAt: new Date("2026-05-31T00:00:00.000Z"),
              acceptedAt: new Date("2026-05-24T00:00:00.000Z"),
              acceptedByActorId: input.actor.id,
              metadata: { source: "signup" },
            },
          };
        },
      },
      outbox: {
        async insert(message) {
          outbox.push(message);
          return "outbox-invite-accepted";
        },
      },
      metering: createRecordingMeteringClient(metering),
      publicBaseUrl: "https://app.helix.example/base",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup/onboarding-invite/accept",
      payload: { token: "invite-token" },
      headers: {
        authorization: "Bearer should-not-leak",
        cookie: "helix_session=should-not-leak",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(accepted).toEqual([
      {
        token: "invite-token",
        actor: {
          id: "22222222-2222-4222-8222-222222222222",
          orgId: "11111111-1111-4111-8111-111111111111",
          type: "user",
          email: "ada@example.com",
        },
      },
    ]);
    expect(response.json()).toMatchObject({
      status: "accepted",
      org: { slug: "acme", status: "active" },
      actorId: "22222222-2222-4222-8222-222222222222",
      workspace: {
        onboardingUrl: "https://acme.helix.example/onboarding",
        welcomeUrl: "https://acme.helix.example/welcome",
      },
    });
    expect(outbox).toEqual([
      {
        subject: "signup.onboarding_invite_accepted",
        payload: {
          orgId: "11111111-1111-4111-8111-111111111111",
          orgSlug: "acme",
          actorId: "22222222-2222-4222-8222-222222222222",
          invitedByActorId: "22222222-2222-4222-8222-222222222222",
          source: "signup",
          step: "onboarding_invite_accepted",
        },
      },
    ]);
    expect(JSON.stringify(outbox)).not.toContain("ada@example.com");
    expect(JSON.stringify(outbox)).not.toContain("invite-token");
    expect(JSON.stringify(outbox)).not.toContain("should-not-leak");
    expect(metering).toEqual([
      {
        orgId: "11111111-1111-4111-8111-111111111111",
        event: {
          type: "seats.delta",
          quantity: 1,
          metadata: {
            source: "signup",
            reason: "onboarding_invite_accepted",
            actorId: "22222222-2222-4222-8222-222222222222",
            invitedByActorId: "22222222-2222-4222-8222-222222222222",
          },
        },
      },
    ]);
    expect(JSON.stringify(metering)).not.toContain("ada@example.com");
    expect(JSON.stringify(metering)).not.toContain("invite-token");
    expect(JSON.stringify(metering)).not.toContain("should-not-leak");
    await app.close();
  });

  it("rejects invite acceptance when the signed-in account does not match", async () => {
    const app = fastify();
    await registerSignupRoutes(app, {
      actorFromRequest: () =>
        testActor({
          email: "wrong@example.com",
        }),
      orgs: createSignupOrgStore(),
      onboardingInvites: {
        async issue() {
          throw new Error("Invite acceptance should not issue a new invite.");
        },
        async accept() {
          return { status: "email_mismatch" };
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup/onboarding-invite/accept",
      payload: { token: "invite-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "signup_onboarding_invite_email_mismatch" },
    });
    await app.close();
  });

  it("requires auth and outbox wiring for onboarding invite delivery", async () => {
    const app = fastify();
    await registerSignupRoutes(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/signup/onboarding-invites",
      payload: { emails: ["ada@example.com"] },
    });

    expect(response.statusCode).toBe(501);
    expect(response.json()).toMatchObject({
      error: {
        code: "signup_onboarding_invites_not_implemented",
        details: { phase: "commercial.B.4", route: "/api/signup/onboarding-invites" },
      },
    });
    await app.close();
  });

  it("emits authenticated welcome activation telemetry without PII", async () => {
    const app = fastify();
    const outbox: unknown[] = [];
    const metrics = createPlatformMetrics();
    await registerSignupRoutes(app, {
      actorFromRequest: () =>
        testActor({
          email: "owner@example.com",
          displayName: "Owner Example",
        }),
      outbox: {
        async insert(message) {
          outbox.push(message);
          return "outbox-welcome";
        },
      },
      metrics,
    });

    const viewed = await app.inject({
      method: "POST",
      url: "/api/signup/welcome-event",
      payload: { event: "viewed" },
      headers: {
        authorization: "Bearer should-not-leak",
        cookie: "helix_session=should-not-leak",
      },
    });
    const clicked = await app.inject({
      method: "POST",
      url: "/api/signup/welcome-event",
      payload: { event: "action_clicked", action: "try_editor" },
    });

    expect(viewed.statusCode).toBe(202);
    expect(viewed.json()).toEqual({ status: "accepted" });
    expect(clicked.statusCode).toBe(202);
    expect(clicked.json()).toEqual({ status: "accepted" });
    expect(outbox).toEqual([
      {
        subject: "signup.welcome_viewed",
        payload: {
          orgId: "11111111-1111-4111-8111-111111111111",
          actorId: "22222222-2222-4222-8222-222222222222",
          source: "signup",
          step: "welcome_viewed",
        },
      },
      {
        subject: "signup.welcome_action_clicked",
        payload: {
          orgId: "11111111-1111-4111-8111-111111111111",
          actorId: "22222222-2222-4222-8222-222222222222",
          source: "signup",
          step: "welcome_action_clicked",
          action: "try_editor",
        },
      },
    ]);
    expect(JSON.stringify(outbox)).not.toContain("owner@example.com");
    expect(JSON.stringify(outbox)).not.toContain("Owner Example");
    expect(JSON.stringify(outbox)).not.toContain("should-not-leak");
    const metricOutput = await metrics.registry.metrics();
    expect(metricOutput).toContain(
      'helix_signup_funnel_events_total{step="welcome_viewed",tier="unknown",plan_id="unknown",region="unknown"} 1',
    );
    expect(metricOutput).toContain(
      'helix_signup_funnel_events_total{step="welcome_action_clicked",tier="unknown",plan_id="unknown",region="unknown"} 1',
    );
    expect(metricOutput).not.toContain("owner@example.com");
    expect(metricOutput).not.toContain("Owner Example");
    await app.close();
  });

  it("rejects invalid welcome activation telemetry without writing outbox events", async () => {
    const app = fastify();
    const outbox: unknown[] = [];
    await registerSignupRoutes(app, {
      actorFromRequest: () => testActor(),
      outbox: {
        async insert(message) {
          outbox.push(message);
          return "outbox-welcome";
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup/welcome-event",
      payload: { event: "action_clicked", action: "owner@example.com" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "bad_request" } });
    expect(outbox).toEqual([]);
    await app.close();
  });

  it("requires auth and outbox wiring for welcome activation telemetry", async () => {
    const missingWiring = fastify();
    await registerSignupRoutes(missingWiring);

    const missingResponse = await missingWiring.inject({
      method: "POST",
      url: "/api/signup/welcome-event",
      payload: { event: "viewed" },
    });

    expect(missingResponse.statusCode).toBe(501);
    expect(missingResponse.json()).toMatchObject({
      error: {
        code: "signup_welcome_telemetry_not_implemented",
        details: { phase: "commercial.B.4", route: "/api/signup/welcome-event" },
      },
    });
    await missingWiring.close();

    const anonymous = fastify();
    const outbox: unknown[] = [];
    await registerSignupRoutes(anonymous, {
      actorFromRequest: () => unauthenticatedActor,
      outbox: {
        async insert(message) {
          outbox.push(message);
          return "outbox-welcome";
        },
      },
    });

    const anonymousResponse = await anonymous.inject({
      method: "POST",
      url: "/api/signup/welcome-event",
      payload: { event: "viewed" },
    });

    expect(anonymousResponse.statusCode).toBe(401);
    expect(anonymousResponse.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect(outbox).toEqual([]);
    await anonymous.close();
  });

  it("activates a provisioning tenant when a ready verification token is submitted", async () => {
    const app = fastify();
    const consumed: string[] = [];
    const succeeded: unknown[] = [];
    const outbox: unknown[] = [];
    const metering: RecordedMeteringEvent[] = [];
    const metrics = createPlatformMetrics();
    await registerSignupRoutes(app, {
      orgs: {
        ...createSignupOrgStore(),
        async activateProvisionedOrg(id) {
          expect(id).toBe("11111111-1111-4111-8111-111111111111");
          return signupOrg({ status: "active" });
        },
      },
      provisioning: {
        async start(input) {
          return provisioningRecord({ orgId: input.orgId });
        },
        async findByOrgId(orgId) {
          return provisioningRecord({
            orgId,
            status: "waiting_for_verification",
            completedSteps: ["initial_owner_actor_created"],
            createdAt: new Date("2026-05-24T12:00:00.000Z"),
          });
        },
        async markSucceeded(input) {
          succeeded.push(input);
          return provisioningRecord({
            orgId: input.orgId,
            status: "succeeded",
            currentStep: input.currentStep,
            completedSteps: input.completedSteps,
            createdAt: new Date("2026-05-24T12:00:00.000Z"),
            completedAt: new Date("2026-05-24T12:00:42.000Z"),
          });
        },
      },
      verificationTokens: {
        async issue(input) {
          return {
            orgId: input.orgId,
            email: input.email,
            passwordHash: "stored-password-hash",
            token: "issued",
            expiresAt: new Date("2026-05-25T00:00:00.000Z"),
            consumedAt: null,
            metadata: {},
          };
        },
        async findValid(input) {
          expect(input.token).toBe("verify-token");
          return verificationRecord({});
        },
        async consume(input) {
          consumed.push(input.token);
          return verificationRecord({});
        },
      },
      identities: {
        async createVerifiedCredentialUser(input) {
          expect(input).toEqual({
            orgId: "11111111-1111-4111-8111-111111111111",
            email: "owner@example.com",
            passwordHash: "stored-password-hash",
          });
          return {
            actorId: "22222222-2222-4222-8222-222222222222",
            betterAuthUserId: "signup-22222222-2222-4222-8222-222222222222",
          };
        },
      },
      outbox: {
        async insert(message) {
          outbox.push(message);
          return "outbox-1";
        },
      },
      metering: createRecordingMeteringClient(metering),
      metrics,
      publicBaseUrl: "https://app.helix.example/base",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup/verify-email",
      payload: { token: "verify-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(consumed).toEqual(["verify-token"]);
    expect(succeeded).toEqual([
      {
        orgId: "11111111-1111-4111-8111-111111111111",
        currentStep: "email_verified",
        completedSteps: ["initial_owner_actor_created", "email_verified"],
      },
    ]);
    expect(outbox).toEqual([
      {
        subject: "tenant.signup_activation_slo.observed",
        payload: {
          orgId: "11111111-1111-4111-8111-111111111111",
          orgSlug: "acme",
          tier: "personal",
          planId: "personal",
          region: "default",
          source: "signup",
          slo: "signup_activation",
          targetSeconds: 60,
          durationSeconds: 42,
          withinTarget: true,
          startedAt: "2026-05-24T12:00:00.000Z",
          completedAt: "2026-05-24T12:00:42.000Z",
          completedStepCount: 2,
        },
      },
      {
        subject: "tenant.provisioned",
        payload: {
          orgId: "11111111-1111-4111-8111-111111111111",
          orgSlug: "acme",
          ownerEmail: "owner@example.com",
          ownerActorId: "22222222-2222-4222-8222-222222222222",
          betterAuthUserId: "signup-22222222-2222-4222-8222-222222222222",
          tier: "personal",
          planId: "personal",
          region: "default",
          source: "signup",
          status: "active",
        },
      },
      {
        subject: "signup.verified",
        payload: {
          orgId: "11111111-1111-4111-8111-111111111111",
          orgSlug: "acme",
          tier: "personal",
          planId: "personal",
          region: "default",
          step: "verified",
          source: "signup",
          ownerActorId: "22222222-2222-4222-8222-222222222222",
          betterAuthUserId: "signup-22222222-2222-4222-8222-222222222222",
        },
      },
    ]);
    const verifiedEvent = outbox.find(
      (message) => (message as { readonly subject?: string }).subject === "signup.verified",
    );
    expect(JSON.stringify(verifiedEvent)).not.toContain("owner@example.com");
    const sloEvent = outbox.find(
      (message) =>
        (message as { readonly subject?: string }).subject ===
        "tenant.signup_activation_slo.observed",
    );
    expect(JSON.stringify(sloEvent)).not.toContain("owner@example.com");
    expect(JSON.stringify(sloEvent)).not.toContain("stored-password-hash");
    expect(JSON.stringify(sloEvent)).not.toContain("verify-token");
    expect(JSON.stringify(signupFunnelMessages(outbox))).not.toContain("stored-password-hash");
    expect(JSON.stringify(signupFunnelMessages(outbox))).not.toContain("verify-token");
    expect(metering).toEqual([
      {
        orgId: "11111111-1111-4111-8111-111111111111",
        event: {
          type: "seats.delta",
          quantity: 1,
          metadata: {
            source: "signup",
            reason: "owner_verified",
            actorId: "22222222-2222-4222-8222-222222222222",
          },
        },
      },
    ]);
    expect(JSON.stringify(metering)).not.toContain("owner@example.com");
    expect(JSON.stringify(metering)).not.toContain("stored-password-hash");
    expect(JSON.stringify(metering)).not.toContain("verify-token");
    const metricOutput = await metrics.registry.metrics();
    expect(metricOutput).toContain(
      'helix_signup_funnel_events_total{step="verified",tier="personal",plan_id="personal",region="default"} 1',
    );
    expect(metricOutput).toContain(
      'helix_signup_activation_duration_seconds_count{tier="personal",plan_id="personal",region="default",within_target="true"} 1',
    );
    expect(metricOutput).toContain(
      'helix_signup_activation_duration_seconds_sum{tier="personal",plan_id="personal",region="default",within_target="true"} 42',
    );
    expect(metricOutput).not.toContain("owner@example.com");
    expect(metricOutput).not.toContain("stored-password-hash");
    expect(metricOutput).not.toContain("verify-token");
    expect(response.json()).toMatchObject({
      status: "active",
      org: { slug: "acme", status: "active" },
      verification: { status: "verified" },
      session: { created: false, status: "credential_ready" },
      workspace: {
        onboardingUrl: "https://acme.helix.example/onboarding",
        welcomeUrl: "https://acme.helix.example/welcome",
      },
    });
    await app.close();
  });

  it("creates a BetterAuth session cookie after successful email verification when configured", async () => {
    const app = fastify();
    const sessions: Array<{
      readonly userId: string;
      readonly requestHeaders?: unknown;
    }> = [];
    await registerSignupRoutes(app, {
      orgs: createSignupOrgStore(),
      provisioning: {
        async start(input) {
          return provisioningRecord({ orgId: input.orgId });
        },
        async findByOrgId(orgId) {
          return provisioningRecord({
            orgId,
            status: "waiting_for_verification",
            completedSteps: ["initial_owner_actor_created"],
          });
        },
        async markSucceeded(input) {
          return provisioningRecord({
            orgId: input.orgId,
            status: "succeeded",
            currentStep: input.currentStep,
            completedSteps: input.completedSteps,
          });
        },
      },
      verificationTokens: {
        async issue(input) {
          return {
            orgId: input.orgId,
            email: input.email,
            passwordHash: "stored-password-hash",
            token: "issued",
            expiresAt: new Date("2026-05-25T00:00:00.000Z"),
            consumedAt: null,
            metadata: {},
          };
        },
        async findValid() {
          return verificationRecord({});
        },
        async consume() {
          return verificationRecord({});
        },
      },
      identities: {
        async createVerifiedCredentialUser() {
          return {
            actorId: "22222222-2222-4222-8222-222222222222",
            betterAuthUserId: "signup-22222222-2222-4222-8222-222222222222",
          };
        },
      },
      sessionIssuer: {
        async issueSession(input) {
          sessions.push(input);
          return {
            token: "session-token",
            expiresAt: new Date("2026-05-31T00:00:00.000Z"),
            cookieName: "helix_session",
            setCookieHeader: "helix_session=signed-session-token; Path=/; HttpOnly; SameSite=Lax",
          };
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup/verify-email",
      payload: { token: "verify-token" },
      headers: { "user-agent": "vitest" },
    });

    expect(response.statusCode).toBe(200);
    expect(sessions[0]?.userId).toBe("signup-22222222-2222-4222-8222-222222222222");
    expect(sessions[0]?.requestHeaders).toMatchObject({ "user-agent": "vitest" });
    expect(response.headers["set-cookie"]).toBe(
      "helix_session=signed-session-token; Path=/; HttpOnly; SameSite=Lax",
    );
    expect(response.json()).toMatchObject({
      session: { created: true, status: "created" },
    });
    await app.close();
  });

  it("does not consume a valid verification token before provisioning is ready", async () => {
    const app = fastify();
    let consumed = 0;
    const outbox: unknown[] = [];
    await registerSignupRoutes(app, {
      orgs: createSignupOrgStore(),
      provisioning: {
        async start(input) {
          return provisioningRecord({ orgId: input.orgId });
        },
        async findByOrgId(orgId) {
          return provisioningRecord({ orgId, status: "running", currentStep: "vault_path" });
        },
        async markSucceeded(input) {
          return provisioningRecord({ orgId: input.orgId, status: "succeeded" });
        },
      },
      verificationTokens: {
        async issue(input) {
          return {
            orgId: input.orgId,
            email: input.email,
            passwordHash: "stored-password-hash",
            token: "issued",
            expiresAt: new Date("2026-05-25T00:00:00.000Z"),
            consumedAt: null,
            metadata: {},
          };
        },
        async findValid() {
          return verificationRecord({});
        },
        async consume() {
          consumed += 1;
          return null;
        },
      },
      identities: {
        async createVerifiedCredentialUser() {
          throw new Error("identity should not be created before provisioning is ready");
        },
      },
      outbox: {
        async insert(message) {
          outbox.push(message);
          return "outbox-should-not-be-used";
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/signup/verify-email",
      payload: { token: "verify-token" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "tenant_not_ready",
        details: { status: "running", currentStep: "vault_path" },
      },
    });
    expect(consumed).toBe(0);
    expect(outbox).toEqual([]);
    await app.close();
  });
});

function validSignupBody(
  overrides: Partial<{
    readonly email: string;
    readonly password: string;
    readonly orgName: string;
    readonly orgSlug: string;
    readonly country: string;
    readonly phone: string;
    readonly marketingOptIn: boolean;
    readonly termsAccepted: boolean;
    readonly privacyAccepted: boolean;
    readonly recaptchaToken: string;
  }> = {},
) {
  return {
    email: overrides.email ?? "owner@example.com",
    password: overrides.password ?? "correct-horse-battery-staple",
    orgName: overrides.orgName ?? "Acme",
    orgSlug: overrides.orgSlug ?? "acme",
    country: overrides.country ?? "US",
    ...(overrides.phone === undefined ? {} : { phone: overrides.phone }),
    marketingOptIn: overrides.marketingOptIn ?? false,
    termsAccepted: overrides.termsAccepted ?? true,
    privacyAccepted: overrides.privacyAccepted ?? true,
    ...(overrides.recaptchaToken === undefined ? {} : { recaptchaToken: overrides.recaptchaToken }),
  };
}

function createSignupOrgStore() {
  return {
    async createOrg(input: CreateOrgInput) {
      return signupOrg({
        slug: input.slug,
        displayName: input.displayName,
        status: input.status ?? "provisioning",
        tier: input.tier ?? "personal",
        planId: input.planId ?? "personal",
        region: input.region ?? "default",
      });
    },
    async activateProvisionedOrg(id: string) {
      return signupOrg({ id, status: "active" });
    },
    async findById(id: string) {
      return signupOrg({ id, status: "active" });
    },
  };
}

function signupOrg(
  overrides: Partial<{
    readonly id: string;
    readonly slug: string;
    readonly displayName: string;
    readonly status: "provisioning" | "active" | "suspended" | "soft_deleted" | "hard_deleted";
    readonly tier: string;
    readonly planId: string;
    readonly region: string;
  }>,
) {
  return {
    id: overrides.id ?? "11111111-1111-4111-8111-111111111111",
    slug: overrides.slug ?? "acme",
    displayName: overrides.displayName ?? "Acme",
    status: overrides.status ?? "provisioning",
    tier: overrides.tier ?? "personal",
    planId: overrides.planId ?? "personal",
    region: overrides.region ?? "default",
    byoConfig: {},
    featureFlags: {},
    quotas: {},
    branding: {},
    suspendedAt: null,
    softDeletedAt: null,
    hardDeletedAt: null,
  };
}

function provisioningRecord(
  overrides: Partial<{
    readonly orgId: string;
    readonly status: "pending" | "running" | "waiting_for_verification" | "succeeded" | "failed";
    readonly requestedOwnerEmail: string;
    readonly currentStep: string;
    readonly completedSteps: readonly string[];
    readonly createdAt: Date;
    readonly completedAt: Date | null;
  }>,
) {
  return {
    orgId: overrides.orgId ?? "11111111-1111-4111-8111-111111111111",
    status: overrides.status ?? "pending",
    requestedOwnerEmail: overrides.requestedOwnerEmail ?? "owner@example.com",
    currentStep: overrides.currentStep ?? "signup_received",
    completedSteps: overrides.completedSteps ?? [],
    attemptCount: 0,
    lastError: null,
    metadata: {},
    createdAt: overrides.createdAt ?? new Date("2026-05-24T00:00:00.000Z"),
    updatedAt: new Date("2026-05-24T00:00:00.000Z"),
    completedAt: overrides.completedAt ?? null,
  };
}

function verificationRecord(
  overrides: Partial<{
    readonly orgId: string;
    readonly email: string;
    readonly passwordHash: string;
    readonly expiresAt: Date;
    readonly consumedAt: Date | null;
    readonly metadata: JsonObject;
  }>,
) {
  return {
    orgId: overrides.orgId ?? "11111111-1111-4111-8111-111111111111",
    email: overrides.email ?? "owner@example.com",
    passwordHash: overrides.passwordHash ?? "stored-password-hash",
    expiresAt: overrides.expiresAt ?? new Date("2026-05-25T00:00:00.000Z"),
    consumedAt: overrides.consumedAt ?? null,
    metadata: overrides.metadata ?? {},
  };
}

function testActor(
  overrides: Partial<
    Pick<Actor, "id" | "orgId" | "type" | "email" | "displayName" | "scopes">
  > = {},
): Actor {
  return {
    id: overrides.id ?? "22222222-2222-4222-8222-222222222222",
    orgId: overrides.orgId ?? "11111111-1111-4111-8111-111111111111",
    type: overrides.type ?? "user",
    ...(overrides.scopes === undefined ? {} : { scopes: overrides.scopes }),
    ...(overrides.email === undefined ? {} : { email: overrides.email }),
    ...(overrides.displayName === undefined ? {} : { displayName: overrides.displayName }),
  };
}

function signupFunnelMessages(messages: readonly unknown[]): readonly unknown[] {
  return messages.filter((message) => {
    const subject = (message as { readonly subject?: unknown }).subject;
    return (
      typeof subject === "string" &&
      subject.startsWith("signup.") &&
      subject !== "signup.verification_email.send" &&
      subject !== "signup.onboarding_invite_email.send"
    );
  });
}

interface RecordedMeteringEvent {
  readonly orgId: string;
  readonly event: MeteringEvent;
  readonly trace?: TraceContext;
}

function createRecordingMeteringClient(events: RecordedMeteringEvent[]): MeteringClient {
  return {
    async emit(orgId, event, trace) {
      events.push({
        orgId,
        event,
        ...(trace === undefined ? {} : { trace }),
      });
    },
    async emitBatch(inputs) {
      for (const input of inputs) {
        events.push({
          orgId: input.orgId,
          event: input.event,
          ...(input.trace === undefined ? {} : { trace: input.trace }),
        });
      }
    },
  };
}
