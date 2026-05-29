import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Actor, HelixConfig, MeteringClient } from "@helix/sdk-types";
import { unauthenticatedActor } from "../../api/actor.js";
import { buildErrorEnvelope } from "../../api/error-envelope.js";
import type { PlatformMetrics } from "../../api/metrics.js";
import { createRequestContext } from "../../api/trace.js";
import { isSaas } from "../mode/index.js";
import type { OutboxStore } from "../outbox/outbox.js";
import type { OrgRecord, OrgStore, TenantProvisioningStore } from "../tenancy/index.js";
import type { BetterAuthSessionIssuer } from "../auth/better-auth.js";
import type {
  SignupEmailVerificationIssueResult,
  SignupEmailVerificationTokenStore,
  SignupOwnerEmailLookup,
  SignupVerifiedIdentityStore,
} from "./verification.js";
import {
  signupOnboardingInviteEmailSubject,
  signupVerificationEmailSubject,
} from "./email-delivery.js";
import type { SignupAbuseProtector, SignupAbuseCheckResult } from "./abuse.js";
import type {
  SignupPasswordScreener,
  SignupPasswordScreeningResult,
} from "./password-screening.js";
import type { SignupRecaptchaVerifier, SignupRecaptchaVerifyResult } from "./recaptcha.js";
import {
  signupOnboardingIdentityAllowedForPlan,
  type SignupOnboardingStore,
} from "./onboarding.js";
import { signupActivationSloObservedSubject, signupFunnelSubjects } from "./event-schemas.js";
import type { SignupOnboardingInviteTokenStore } from "./invites.js";
import type { SignupRiskReviewDecision, SignupRiskReviewer } from "./risk-review.js";
import { emitSeatDelta } from "../metering/seat-events.js";

const defaultPublicBaseUrl = "http://localhost:3000";

const signupRiskReviewRequestedSubject = "tenant.signup_risk_review.requested";
const signupActivationSloTargetSeconds = 60;

const reservedOrgSlugs = new Set([
  "admin",
  "api",
  "app",
  "assets",
  "auth",
  "billing",
  "calendar",
  "cdn",
  "dav",
  "docs",
  "drive",
  "help",
  "login",
  "logout",
  "mail",
  "meet",
  "settings",
  "signup",
  "static",
  "status",
  "support",
  "webhooks",
  "www",
]);

const orgSlugSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u)
  .refine((slug) => !reservedOrgSlugs.has(slug), "Reserved organization slug");

const signupBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(12).max(1024),
  orgName: z.string().min(1).max(64),
  orgSlug: orgSlugSchema,
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/u),
  phone: z.preprocess(
    (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
    z.string().trim().min(3).max(32).optional(),
  ),
  marketingOptIn: z.boolean().default(false),
  termsAccepted: z.literal(true),
  privacyAccepted: z.literal(true),
  recaptchaToken: z.string().min(1).max(4096).optional(),
});

const verifyEmailBodySchema = z.object({
  token: z.string().min(1).max(4096),
});

const signupFunnelTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => !hasControlCharacters(value), "Control characters are not accepted")
  .refine((value) => !value.includes("@"), "PII-like values are not accepted")
  .refine((value) => !/^https?:\/\//iu.test(value), "URLs are not accepted");

const signupFormViewedBodySchema = z
  .object({
    page: z.literal("signup"),
    attribution: z
      .object({
        utmSource: signupFunnelTextSchema.optional(),
        utmMedium: signupFunnelTextSchema.optional(),
        utmCampaign: signupFunnelTextSchema.optional(),
        utmTerm: signupFunnelTextSchema.optional(),
        utmContent: signupFunnelTextSchema.optional(),
        referrerOrigin: z
          .string()
          .trim()
          .url()
          .max(256)
          .refine((value) => !value.includes("@"), "PII-like values are not accepted")
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const resendVerificationBodySchema = z.object({
  token: z.string().min(1).max(4096),
});

const onboardingPlanChoiceSchema = z.enum(["pro-trial", "personal", "sales"]);
const onboardingIdentityChoiceSchema = z.enum([
  "local",
  "google",
  "microsoft",
  "okta",
  "oidc",
  "saml",
]);
const onboardingStepSchema = z.enum(["plan", "invite", "sso"]);

const onboardingEventBodySchema = z.discriminatedUnion("event", [
  z
    .object({
      event: z.literal("started"),
    })
    .strict(),
  z
    .object({
      event: z.literal("completed"),
      planChoice: onboardingPlanChoiceSchema.optional(),
      inviteCount: z.number().int().min(0).max(10).optional(),
      identityChoice: onboardingIdentityChoiceSchema.optional(),
      skipped: z.boolean().optional(),
    })
    .strict(),
]);

const onboardingProgressBodySchema = z
  .object({
    currentStep: onboardingStepSchema,
    planChoice: onboardingPlanChoiceSchema.optional(),
    inviteCount: z.number().int().min(0).max(10).optional(),
    identityChoice: onboardingIdentityChoiceSchema.optional(),
  })
  .strict();

const onboardingInvitesBodySchema = z.object({
  emails: z.array(z.string().trim().toLowerCase().email()).min(1).max(10),
});

const onboardingInviteAcceptBodySchema = z.object({
  token: z.string().min(1).max(4096),
});

function invalidOnboardingIdentityChoice(
  reply: FastifyReply,
  request: FastifyRequest,
): FastifyReply {
  return reply.code(400).send(
    buildErrorEnvelope({
      statusCode: 400,
      code: "bad_request",
      message: "Selected SSO provider is not available for the onboarding plan choice.",
      traceId: traceIdForRequest(request),
    }),
  );
}

const welcomeActionSchema = z.enum([
  "try_editor",
  "install_integration",
  "invite_team",
  "view_docs",
]);

const welcomeEventBodySchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("viewed"),
  }),
  z.object({
    event: z.literal("action_clicked"),
    action: welcomeActionSchema,
  }),
]);

const slugAvailabilityParamsSchema = z.object({
  slug: z.string().min(1).max(255),
});

export function shouldRegisterSignupRoutes(config: Pick<HelixConfig, "mode">): boolean {
  return isSaas(config);
}

export async function registerSignupRoutesForMode(
  app: FastifyInstance,
  options: {
    readonly config: Pick<HelixConfig, "mode">;
    readonly orgs?: SignupOrgStore;
    readonly provisioning?: SignupProvisioningStore;
    readonly verificationTokens?: SignupEmailVerificationTokenStore;
    readonly identities?: SignupVerifiedIdentityStore;
    readonly sessionIssuer?: BetterAuthSessionIssuer;
    readonly outbox?: Pick<OutboxStore, "insert">;
    readonly publicBaseUrl?: string;
    readonly abuse?: SignupAbuseProtector;
    readonly ownerEmails?: SignupOwnerEmailLookup;
    readonly passwordScreener?: SignupPasswordScreener;
    readonly recaptcha?: SignupRecaptchaVerifier;
    readonly riskReviewer?: SignupRiskReviewer;
    readonly actorFromRequest?: (request: FastifyRequest) => Actor | Promise<Actor>;
    readonly onboarding?: SignupOnboardingStore;
    readonly onboardingInvites?: SignupOnboardingInviteTokenStore;
    readonly metering?: MeteringClient;
    readonly onMeteringError?: (error: unknown) => void;
    readonly metrics?: PlatformMetrics;
  },
): Promise<void> {
  if (!shouldRegisterSignupRoutes(options.config)) {
    return;
  }
  await registerSignupRoutes(app, {
    ...(options.orgs === undefined ? {} : { orgs: options.orgs }),
    ...(options.provisioning === undefined ? {} : { provisioning: options.provisioning }),
    ...(options.verificationTokens === undefined
      ? {}
      : { verificationTokens: options.verificationTokens }),
    ...(options.identities === undefined ? {} : { identities: options.identities }),
    ...(options.sessionIssuer === undefined ? {} : { sessionIssuer: options.sessionIssuer }),
    ...(options.outbox === undefined ? {} : { outbox: options.outbox }),
    ...(options.publicBaseUrl === undefined ? {} : { publicBaseUrl: options.publicBaseUrl }),
    ...(options.abuse === undefined ? {} : { abuse: options.abuse }),
    ...(options.ownerEmails === undefined ? {} : { ownerEmails: options.ownerEmails }),
    ...(options.passwordScreener === undefined
      ? {}
      : { passwordScreener: options.passwordScreener }),
    ...(options.recaptcha === undefined ? {} : { recaptcha: options.recaptcha }),
    ...(options.riskReviewer === undefined ? {} : { riskReviewer: options.riskReviewer }),
    ...(options.actorFromRequest === undefined
      ? {}
      : { actorFromRequest: options.actorFromRequest }),
    ...(options.onboarding === undefined ? {} : { onboarding: options.onboarding }),
    ...(options.onboardingInvites === undefined
      ? {}
      : { onboardingInvites: options.onboardingInvites }),
    ...(options.metering === undefined ? {} : { metering: options.metering }),
    ...(options.onMeteringError === undefined ? {} : { onMeteringError: options.onMeteringError }),
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
  });
}

export async function registerSignupRoutes(
  app: FastifyInstance,
  options: {
    readonly orgs?: SignupOrgStore;
    readonly provisioning?: SignupProvisioningStore;
    readonly verificationTokens?: SignupEmailVerificationTokenStore;
    readonly identities?: SignupVerifiedIdentityStore;
    readonly sessionIssuer?: BetterAuthSessionIssuer;
    readonly outbox?: Pick<OutboxStore, "insert">;
    readonly publicBaseUrl?: string;
    readonly abuse?: SignupAbuseProtector;
    readonly ownerEmails?: SignupOwnerEmailLookup;
    readonly passwordScreener?: SignupPasswordScreener;
    readonly recaptcha?: SignupRecaptchaVerifier;
    readonly riskReviewer?: SignupRiskReviewer;
    readonly actorFromRequest?: (request: FastifyRequest) => Actor | Promise<Actor>;
    readonly onboarding?: SignupOnboardingStore;
    readonly onboardingInvites?: SignupOnboardingInviteTokenStore;
    readonly metering?: MeteringClient;
    readonly onMeteringError?: (error: unknown) => void;
    readonly metrics?: PlatformMetrics;
  } = {},
): Promise<void> {
  app.get("/api/signup/org-slug/:slug/availability", async (request, reply) => {
    const parsed = slugAvailabilityParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send(
        buildErrorEnvelope({
          statusCode: 400,
          code: "bad_request",
          message: `Invalid signup slug availability request: ${parsed.error.message}`,
          traceId: traceIdForRequest(request),
        }),
      );
    }

    const slug = parsed.data.slug;
    const validation = validateOrgSlug(slug);
    if (!validation.valid) {
      return {
        slug,
        valid: false,
        available: false,
        reason: validation.reason,
      };
    }

    if (options.orgs?.findBySlug === undefined) {
      return reply.code(501).send(
        buildErrorEnvelope({
          statusCode: 501,
          code: "signup_slug_check_not_implemented",
          message:
            "Signup organization slug availability is registered for SaaS mode but is not implemented yet.",
          traceId: traceIdForRequest(request),
          details: {
            phase: "commercial.B.4",
            route: "/api/signup/org-slug/:slug/availability",
          },
        }),
      );
    }

    const existing = await options.orgs.findBySlug(slug);
    if (existing !== null) {
      return {
        slug,
        valid: true,
        available: false,
        reason: "taken",
      };
    }

    return {
      slug,
      valid: true,
      available: true,
    };
  });

  app.post("/api/signup", async (request, reply) => {
    const parsed = signupBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        buildErrorEnvelope({
          statusCode: 400,
          code: "bad_request",
          message: `Invalid signup request body: ${parsed.error.message}`,
          traceId: traceIdForRequest(request),
        }),
      );
    }

    const recaptchaDecision = await options.recaptcha?.verify({
      token: parsed.data.recaptchaToken,
      ip: request.ip,
    });
    if (recaptchaDecision !== undefined && !recaptchaDecision.allowed) {
      return sendSignupRecaptchaRejection(reply, request, recaptchaDecision);
    }

    const abuseDecision = await options.abuse?.check({
      email: parsed.data.email,
      ip: request.ip,
    });
    if (abuseDecision !== undefined && !abuseDecision.allowed) {
      return sendSignupAbuseRejection(reply, request, abuseDecision);
    }

    const existingOwner = await options.ownerEmails?.findOwnerByEmail(parsed.data.email);
    if (existingOwner !== undefined && existingOwner !== null) {
      return reply.code(409).send(
        buildErrorEnvelope({
          statusCode: 409,
          code: "signup_owner_email_unavailable",
          message: "That email address is already an owner of another workspace.",
          traceId: traceIdForRequest(request),
        }),
      );
    }

    const passwordDecision = await options.passwordScreener?.check({
      email: parsed.data.email,
      orgName: parsed.data.orgName,
      password: parsed.data.password,
    });
    if (passwordDecision !== undefined && !passwordDecision.allowed) {
      return sendSignupPasswordRejection(reply, request, passwordDecision);
    }

    const riskReview = await options.riskReviewer?.review({
      country: parsed.data.country,
      phone: parsed.data.phone,
    });

    if (options.orgs !== undefined) {
      let org: OrgRecord;
      try {
        org = await startSignupProvisioning({
          orgs: options.orgs,
          input: parsed.data,
        });
      } catch (error: unknown) {
        if (isUniqueViolation(error)) {
          return reply.code(409).send(
            buildErrorEnvelope({
              statusCode: 409,
              code: "org_slug_unavailable",
              message: "That organization slug is not available.",
              traceId: traceIdForRequest(request),
            }),
          );
        }
        throw error;
      }
      await options.provisioning?.start({
        orgId: org.id,
        requestedOwnerEmail: parsed.data.email,
        currentStep: "signup_received",
        metadata: {
          source: "signup",
          orgSlug: parsed.data.orgSlug,
          ...signupMetadata(parsed.data, riskReview),
        },
      });
      await enqueueSignupRiskReviewRequested({
        outbox: options.outbox,
        org,
        riskReview,
        request,
      });
      await enqueueSignupFunnelEvent({
        outbox: options.outbox,
        metrics: options.metrics,
        subject: signupFunnelSubjects.formSubmitted,
        org,
        request,
        payload: {
          step: "form_submitted",
          source: "signup",
        },
      });
      const verification = await options.verificationTokens?.issue({
        orgId: org.id,
        email: parsed.data.email,
        password: parsed.data.password,
        metadata: {
          source: "signup",
          orgSlug: parsed.data.orgSlug,
          ...signupMetadata(parsed.data, riskReview),
        },
      });
      if (verification !== undefined) {
        await enqueueSignupVerificationEmail({
          outbox: options.outbox,
          org,
          email: verification.email,
          verification,
          publicBaseUrl: options.publicBaseUrl ?? defaultPublicBaseUrl,
          request,
        });
        await enqueueSignupFunnelEvent({
          outbox: options.outbox,
          metrics: options.metrics,
          subject: signupFunnelSubjects.verificationSent,
          org,
          request,
          payload: {
            step: "verification_sent",
            source: "signup",
            expiresAt: verification.expiresAt.toISOString(),
          },
        });
      }
      return reply.code(202).send({
        status: "provisioning",
        org: publicSignupOrg(org),
        verification: {
          required: true,
          status: "pending",
          ...(verification === undefined
            ? {}
            : { expiresAt: verification.expiresAt.toISOString() }),
        },
      });
    }

    return reply.code(501).send(
      buildErrorEnvelope({
        statusCode: 501,
        code: "signup_not_implemented",
        message:
          "Self-service signup provisioning is registered for SaaS mode but is not implemented yet.",
        traceId: traceIdForRequest(request),
        details: { phase: "platform-v2.A.8", route: "/api/signup" },
      }),
    );
  });

  app.post("/api/signup/form-viewed", async (request, reply) => {
    const parsed = signupFormViewedBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        buildErrorEnvelope({
          statusCode: 400,
          code: "bad_request",
          message: `Invalid signup form-viewed request body: ${parsed.error.message}`,
          traceId: traceIdForRequest(request),
        }),
      );
    }

    if (options.outbox === undefined) {
      return reply.code(501).send(
        buildErrorEnvelope({
          statusCode: 501,
          code: "signup_form_viewed_telemetry_not_implemented",
          message:
            "Signup form-viewed telemetry is registered for SaaS mode but is not implemented yet.",
          traceId: traceIdForRequest(request),
          details: { phase: "commercial.B.4", route: "/api/signup/form-viewed" },
        }),
      );
    }

    await options.outbox.insert({
      subject: signupFunnelSubjects.formViewed,
      payload: {
        step: "form_viewed",
        source: "signup",
        page: parsed.data.page,
        ...(parsed.data.attribution === undefined
          ? {}
          : { attribution: compactRecord(parsed.data.attribution) }),
      },
      ...traceForOutbox(request),
    });
    recordSignupFunnelMetric(options.metrics, { step: "form_viewed" });

    return reply.code(202).send({ status: "accepted" });
  });

  app.post("/api/signup/verify-email", async (request, reply) => {
    const parsed = verifyEmailBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        buildErrorEnvelope({
          statusCode: 400,
          code: "bad_request",
          message: `Invalid signup verification request body: ${parsed.error.message}`,
          traceId: traceIdForRequest(request),
        }),
      );
    }

    const activation = signupActivationStores(options);
    if (activation === null) {
      return reply.code(501).send(
        buildErrorEnvelope({
          statusCode: 501,
          code: "signup_verify_not_implemented",
          message:
            "Signup email verification is registered for SaaS mode but is not implemented yet.",
          traceId: traceIdForRequest(request),
          details: { phase: "platform-v2.A.8", route: "/api/signup/verify-email" },
        }),
      );
    }

    const tokenRecord = await activation.verificationTokens.findValid({ token: parsed.data.token });
    if (tokenRecord === null) {
      return reply.code(400).send(
        buildErrorEnvelope({
          statusCode: 400,
          code: "signup_verification_invalid",
          message: "Signup email verification token is invalid or expired.",
          traceId: traceIdForRequest(request),
        }),
      );
    }

    const provisioning = await activation.provisioning.findByOrgId(tokenRecord.orgId);
    if (provisioning?.status !== "waiting_for_verification") {
      const provisioningStatus = provisioning?.status ?? "missing";
      const currentStep = provisioning?.currentStep ?? null;
      return reply.code(409).send(
        buildErrorEnvelope({
          statusCode: 409,
          code: "tenant_not_ready",
          message: "Tenant provisioning has not completed its pre-verification steps.",
          traceId: traceIdForRequest(request),
          details: {
            status: provisioningStatus,
            currentStep,
          },
        }),
      );
    }

    const consumed = await activation.verificationTokens.consume({ token: parsed.data.token });
    if (consumed === null) {
      return reply.code(400).send(
        buildErrorEnvelope({
          statusCode: 400,
          code: "signup_verification_invalid",
          message: "Signup email verification token is invalid or expired.",
          traceId: traceIdForRequest(request),
        }),
      );
    }

    const identity = await activation.identities.createVerifiedCredentialUser({
      orgId: consumed.orgId,
      email: consumed.email,
      passwordHash: consumed.passwordHash,
    });
    if (identity === null) {
      return reply.code(409).send(
        buildErrorEnvelope({
          statusCode: 409,
          code: "signup_identity_conflict",
          message: "Verified signup identity could not be linked to the tenant owner actor.",
          traceId: traceIdForRequest(request),
        }),
      );
    }

    const org = await activation.orgs.activateProvisionedOrg(consumed.orgId);
    if (org === null) {
      return reply.code(409).send(
        buildErrorEnvelope({
          statusCode: 409,
          code: "tenant_activation_conflict",
          message: "Tenant could not be activated from its current status.",
          traceId: traceIdForRequest(request),
        }),
      );
    }

    const succeededProvisioning = await activation.provisioning.markSucceeded({
      orgId: org.id,
      currentStep: "email_verified",
      completedSteps: uniqueSteps([...provisioning.completedSteps, "email_verified"]),
    });
    await enqueueSignupActivationSloObserved({
      outbox: activation.outbox,
      metrics: options.metrics,
      org,
      provisioning,
      succeededProvisioning,
      request,
    });
    emitSeatDelta({
      metering: options.metering,
      onMeteringError: options.onMeteringError,
      orgId: org.id,
      quantity: 1,
      source: "signup",
      reason: "owner_verified",
      actorId: identity.actorId,
      trace: traceForOutbox(request).trace,
    });
    await activation.outbox?.insert({
      subject: "tenant.provisioned",
      payload: {
        orgId: org.id,
        orgSlug: org.slug,
        ownerEmail: consumed.email,
        ownerActorId: identity.actorId,
        betterAuthUserId: identity.betterAuthUserId,
        tier: org.tier,
        planId: org.planId,
        region: org.region,
        source: "signup",
        status: "active",
      },
      ...traceForOutbox(request),
    });
    await enqueueSignupFunnelEvent({
      outbox: activation.outbox,
      metrics: options.metrics,
      subject: signupFunnelSubjects.verified,
      org,
      request,
      payload: {
        step: "verified",
        source: "signup",
        ownerActorId: identity.actorId,
        betterAuthUserId: identity.betterAuthUserId,
      },
    });

    const session = await activation.sessionIssuer?.issueSession({
      userId: identity.betterAuthUserId,
      requestHeaders: request.headers,
    });
    if (session !== undefined) {
      reply.header("set-cookie", session.setCookieHeader);
    }

    return {
      status: "active",
      org: publicSignupOrg(org),
      verification: {
        status: "verified",
      },
      session: {
        created: session !== undefined,
        status: session === undefined ? "credential_ready" : "created",
      },
      workspace: buildSignupWorkspaceUrls(options.publicBaseUrl ?? defaultPublicBaseUrl, org.slug),
    };
  });

  app.post("/api/signup/resend-verification", async (request, reply) => {
    const parsed = resendVerificationBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        buildErrorEnvelope({
          statusCode: 400,
          code: "bad_request",
          message: `Invalid signup verification resend request body: ${parsed.error.message}`,
          traceId: traceIdForRequest(request),
        }),
      );
    }

    if (
      options.verificationTokens?.reissueFromToken === undefined ||
      options.outbox === undefined
    ) {
      return reply.code(501).send(
        buildErrorEnvelope({
          statusCode: 501,
          code: "signup_verification_resend_not_implemented",
          message:
            "Signup email verification resend is registered for SaaS mode but is not implemented yet.",
          traceId: traceIdForRequest(request),
          details: { phase: "commercial.B.4", route: "/api/signup/resend-verification" },
        }),
      );
    }

    const reissue = await options.verificationTokens.reissueFromToken({
      token: parsed.data.token,
    });
    if (reissue.status === "rate_limited") {
      reply.header("retry-after", String(reissue.retryAfterSeconds));
      return reply.code(429).send(
        buildErrorEnvelope({
          statusCode: 429,
          code: "signup_verification_resend_rate_limited",
          message: "Too many signup verification resend attempts.",
          traceId: traceIdForRequest(request),
        }),
      );
    }
    if (reissue.status === "issued") {
      const org = {
        id: reissue.verification.orgId,
        slug: orgSlugFromSignupMetadata(reissue.verification.metadata),
      };
      await enqueueSignupVerificationEmail({
        outbox: options.outbox,
        org,
        email: reissue.verification.email,
        verification: reissue.verification,
        publicBaseUrl: options.publicBaseUrl ?? defaultPublicBaseUrl,
        request,
      });
      await options.outbox.insert({
        subject: signupFunnelSubjects.verificationSent,
        payload: {
          orgId: org.id,
          orgSlug: org.slug,
          step: "verification_sent",
          source: "signup",
          resend: true,
          expiresAt: reissue.verification.expiresAt.toISOString(),
        },
        ...traceForOutbox(request),
      });
      recordSignupFunnelMetric(options.metrics, { step: "verification_sent" });
    }

    return reply.code(202).send({ status: "accepted" });
  });

  app.get("/api/signup/onboarding-state", async (request, reply) => {
    if (options.actorFromRequest === undefined || options.onboarding?.getState === undefined) {
      return reply.code(501).send(
        buildErrorEnvelope({
          statusCode: 501,
          code: "signup_onboarding_state_not_implemented",
          message:
            "Signup onboarding state recovery is registered for SaaS mode but is not implemented yet.",
          traceId: traceIdForRequest(request),
          details: { phase: "commercial.B.4", route: "/api/signup/onboarding-state" },
        }),
      );
    }

    const actor = await options.actorFromRequest(request);
    if (isUnauthenticated(actor)) {
      return reply.code(401).send(
        buildErrorEnvelope({
          statusCode: 401,
          code: "unauthorized",
          message: "Authentication required.",
          traceId: traceIdForRequest(request),
        }),
      );
    }

    return options.onboarding.getState(actor.orgId);
  });

  app.post("/api/signup/onboarding-progress", async (request, reply) => {
    const parsed = onboardingProgressBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        buildErrorEnvelope({
          statusCode: 400,
          code: "bad_request",
          message: `Invalid signup onboarding progress request body: ${parsed.error.message}`,
          traceId: traceIdForRequest(request),
        }),
      );
    }
    if (
      !signupOnboardingIdentityAllowedForPlan(parsed.data.planChoice, parsed.data.identityChoice)
    ) {
      return invalidOnboardingIdentityChoice(reply, request);
    }

    if (options.actorFromRequest === undefined || options.onboarding?.persistProgress === undefined) {
      return reply.code(501).send(
        buildErrorEnvelope({
          statusCode: 501,
          code: "signup_onboarding_progress_not_implemented",
          message:
            "Signup onboarding progress recovery is registered for SaaS mode but is not implemented yet.",
          traceId: traceIdForRequest(request),
          details: { phase: "commercial.B.4", route: "/api/signup/onboarding-progress" },
        }),
      );
    }

    const actor = await options.actorFromRequest(request);
    if (isUnauthenticated(actor)) {
      return reply.code(401).send(
        buildErrorEnvelope({
          statusCode: 401,
          code: "unauthorized",
          message: "Authentication required.",
          traceId: traceIdForRequest(request),
        }),
      );
    }

    await options.onboarding.persistProgress({
      orgId: actor.orgId,
      actorId: actor.id,
      currentStep: parsed.data.currentStep,
      ...(parsed.data.planChoice === undefined ? {} : { planChoice: parsed.data.planChoice }),
      ...(parsed.data.inviteCount === undefined ? {} : { inviteCount: parsed.data.inviteCount }),
      ...(parsed.data.identityChoice === undefined
        ? {}
        : { identityChoice: parsed.data.identityChoice }),
    });

    return reply.code(202).send({ status: "accepted" });
  });

  app.post("/api/signup/onboarding-event", async (request, reply) => {
    const parsed = onboardingEventBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        buildErrorEnvelope({
          statusCode: 400,
          code: "bad_request",
          message: `Invalid signup onboarding event request body: ${parsed.error.message}`,
          traceId: traceIdForRequest(request),
        }),
      );
    }
    if (
      parsed.data.event === "completed" &&
      !signupOnboardingIdentityAllowedForPlan(parsed.data.planChoice, parsed.data.identityChoice)
    ) {
      return invalidOnboardingIdentityChoice(reply, request);
    }

    if (options.actorFromRequest === undefined || options.outbox === undefined) {
      return reply.code(501).send(
        buildErrorEnvelope({
          statusCode: 501,
          code: "signup_onboarding_telemetry_not_implemented",
          message:
            "Signup onboarding telemetry is registered for SaaS mode but is not implemented yet.",
          traceId: traceIdForRequest(request),
          details: { phase: "commercial.B.4", route: "/api/signup/onboarding-event" },
        }),
      );
    }

    const actor = await options.actorFromRequest(request);
    if (isUnauthenticated(actor)) {
      return reply.code(401).send(
        buildErrorEnvelope({
          statusCode: 401,
          code: "unauthorized",
          message: "Authentication required.",
          traceId: traceIdForRequest(request),
        }),
      );
    }

    const subject =
      parsed.data.event === "started"
        ? signupFunnelSubjects.onboardingStarted
        : signupFunnelSubjects.onboardingCompleted;
    const eventDetails =
      parsed.data.event === "completed"
        ? {
            ...(parsed.data.planChoice === undefined ? {} : { planChoice: parsed.data.planChoice }),
            ...(parsed.data.inviteCount === undefined
              ? {}
              : { inviteCount: parsed.data.inviteCount }),
            ...(parsed.data.identityChoice === undefined
              ? {}
              : { identityChoice: parsed.data.identityChoice }),
            ...(parsed.data.skipped === undefined ? {} : { skipped: parsed.data.skipped }),
          }
        : {};
    if (parsed.data.event === "completed") {
      await options.onboarding?.persistCompletion({
        orgId: actor.orgId,
        actorId: actor.id,
        ...eventDetails,
      });
    }
    await options.outbox.insert({
      subject,
      payload: {
        orgId: actor.orgId,
        actorId: actor.id,
        source: "signup",
        step: parsed.data.event === "started" ? "onboarding_started" : "onboarding_completed",
        ...eventDetails,
      },
      ...traceForOutbox(request),
    });
    recordSignupFunnelMetric(options.metrics, {
      step: parsed.data.event === "started" ? "onboarding_started" : "onboarding_completed",
    });

    return reply.code(202).send({ status: "accepted" });
  });

  app.post("/api/signup/onboarding-invites", async (request, reply) => {
    const parsed = onboardingInvitesBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        buildErrorEnvelope({
          statusCode: 400,
          code: "bad_request",
          message: `Invalid signup onboarding invites request body: ${parsed.error.message}`,
          traceId: traceIdForRequest(request),
        }),
      );
    }

    if (
      options.actorFromRequest === undefined ||
      options.outbox === undefined ||
      options.onboardingInvites === undefined ||
      options.orgs?.findById === undefined
    ) {
      return reply.code(501).send(
        buildErrorEnvelope({
          statusCode: 501,
          code: "signup_onboarding_invites_not_implemented",
          message:
            "Signup onboarding invite delivery is registered for SaaS mode but is not implemented yet.",
          traceId: traceIdForRequest(request),
          details: { phase: "commercial.B.4", route: "/api/signup/onboarding-invites" },
        }),
      );
    }

    const actor = await options.actorFromRequest(request);
    if (isUnauthenticated(actor)) {
      return reply.code(401).send(
        buildErrorEnvelope({
          statusCode: 401,
          code: "unauthorized",
          message: "Authentication required.",
          traceId: traceIdForRequest(request),
        }),
      );
    }
    if (!canSendSignupOnboardingInvites(actor)) {
      return reply.code(403).send(
        buildErrorEnvelope({
          statusCode: 403,
          code: "forbidden",
          message: "Admin access is required to invite teammates.",
          traceId: traceIdForRequest(request),
        }),
      );
    }

    const org = await options.orgs.findById(actor.orgId);
    if (org === null) {
      return reply.code(409).send(
        buildErrorEnvelope({
          statusCode: 409,
          code: "signup_onboarding_invites_org_not_found",
          message: "Invite delivery could not resolve the current workspace.",
          traceId: traceIdForRequest(request),
        }),
      );
    }

    const emails = uniqueSteps(parsed.data.emails);
    for (const email of emails) {
      const invite = await options.onboardingInvites.issue({
        orgId: actor.orgId,
        invitedByActorId: actor.id,
        email,
        metadata: { source: "signup" },
      });
      await options.outbox.insert({
        subject: signupOnboardingInviteEmailSubject,
        payload: {
          orgId: actor.orgId,
          orgSlug: org.slug,
          actorId: actor.id,
          email,
          inviteUrl: buildSignupOnboardingInviteUrl(
            options.publicBaseUrl ?? defaultPublicBaseUrl,
            org.slug,
            invite.token,
          ),
          source: "signup",
        },
        ...traceForOutbox(request),
      });
    }

    return reply.code(202).send({ status: "accepted", inviteCount: emails.length });
  });

  app.post("/api/signup/onboarding-invite/accept", async (request, reply) => {
    const parsed = onboardingInviteAcceptBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        buildErrorEnvelope({
          statusCode: 400,
          code: "bad_request",
          message: `Invalid signup onboarding invite acceptance request body: ${parsed.error.message}`,
          traceId: traceIdForRequest(request),
        }),
      );
    }

    if (
      options.actorFromRequest === undefined ||
      options.onboardingInvites === undefined ||
      options.orgs?.findById === undefined
    ) {
      return reply.code(501).send(
        buildErrorEnvelope({
          statusCode: 501,
          code: "signup_onboarding_invite_accept_not_implemented",
          message:
            "Signup onboarding invite acceptance is registered for SaaS mode but is not implemented yet.",
          traceId: traceIdForRequest(request),
          details: { phase: "commercial.B.4", route: "/api/signup/onboarding-invite/accept" },
        }),
      );
    }

    const actor = await options.actorFromRequest(request);
    if (isUnauthenticated(actor)) {
      return reply.code(401).send(
        buildErrorEnvelope({
          statusCode: 401,
          code: "unauthorized",
          message: "Authentication required.",
          traceId: traceIdForRequest(request),
        }),
      );
    }

    const acceptance = await options.onboardingInvites.accept({
      token: parsed.data.token,
      actor,
    });
    if (acceptance.status === "not_found") {
      return reply.code(400).send(
        buildErrorEnvelope({
          statusCode: 400,
          code: "signup_onboarding_invite_invalid",
          message: "Signup onboarding invite is invalid or expired.",
          traceId: traceIdForRequest(request),
        }),
      );
    }
    if (acceptance.status === "email_mismatch") {
      return reply.code(403).send(
        buildErrorEnvelope({
          statusCode: 403,
          code: "signup_onboarding_invite_email_mismatch",
          message: "Sign in with the invited email address before accepting this invite.",
          traceId: traceIdForRequest(request),
        }),
      );
    }

    const org = await options.orgs.findById(acceptance.invite.orgId);
    if (org === null) {
      return reply.code(409).send(
        buildErrorEnvelope({
          statusCode: 409,
          code: "signup_onboarding_invite_org_not_found",
          message: "Invite acceptance could not resolve the invited workspace.",
          traceId: traceIdForRequest(request),
        }),
      );
    }

    await options.outbox?.insert({
      subject: signupFunnelSubjects.onboardingInviteAccepted,
      payload: {
        orgId: org.id,
        orgSlug: org.slug,
        actorId: actor.id,
        invitedByActorId: acceptance.invite.invitedByActorId,
        source: "signup",
        step: "onboarding_invite_accepted",
      },
      ...traceForOutbox(request),
    });
    recordSignupFunnelMetric(options.metrics, {
      step: "onboarding_invite_accepted",
      org,
    });
    emitSeatDelta({
      metering: options.metering,
      onMeteringError: options.onMeteringError,
      orgId: org.id,
      quantity: 1,
      source: "signup",
      reason: "onboarding_invite_accepted",
      actorId: actor.id,
      invitedByActorId: acceptance.invite.invitedByActorId,
      trace: traceForOutbox(request).trace,
    });

    return {
      status: "accepted",
      org: publicSignupOrg(org),
      actorId: actor.id,
      workspace: buildSignupWorkspaceUrls(options.publicBaseUrl ?? defaultPublicBaseUrl, org.slug),
    };
  });

  app.post("/api/signup/welcome-event", async (request, reply) => {
    const parsed = welcomeEventBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        buildErrorEnvelope({
          statusCode: 400,
          code: "bad_request",
          message: `Invalid signup welcome event request body: ${parsed.error.message}`,
          traceId: traceIdForRequest(request),
        }),
      );
    }

    if (options.actorFromRequest === undefined || options.outbox === undefined) {
      return reply.code(501).send(
        buildErrorEnvelope({
          statusCode: 501,
          code: "signup_welcome_telemetry_not_implemented",
          message:
            "Signup welcome activation telemetry is registered for SaaS mode but is not implemented yet.",
          traceId: traceIdForRequest(request),
          details: { phase: "commercial.B.4", route: "/api/signup/welcome-event" },
        }),
      );
    }

    const actor = await options.actorFromRequest(request);
    if (isUnauthenticated(actor)) {
      return reply.code(401).send(
        buildErrorEnvelope({
          statusCode: 401,
          code: "unauthorized",
          message: "Authentication required.",
          traceId: traceIdForRequest(request),
        }),
      );
    }

    await options.outbox.insert({
      subject:
        parsed.data.event === "viewed"
          ? signupFunnelSubjects.welcomeViewed
          : signupFunnelSubjects.welcomeActionClicked,
      payload: {
        orgId: actor.orgId,
        actorId: actor.id,
        source: "signup",
        step: parsed.data.event === "viewed" ? "welcome_viewed" : "welcome_action_clicked",
        ...(parsed.data.event === "action_clicked" ? { action: parsed.data.action } : {}),
      },
      ...traceForOutbox(request),
    });
    recordSignupFunnelMetric(options.metrics, {
      step: parsed.data.event === "viewed" ? "welcome_viewed" : "welcome_action_clicked",
    });

    return reply.code(202).send({ status: "accepted" });
  });
}

type SignupOrgStore = Pick<OrgStore, "createOrg"> &
  Partial<Pick<OrgStore, "activateProvisionedOrg" | "findById" | "findBySlug">>;

type SignupProvisioningStore = Pick<TenantProvisioningStore, "start"> &
  Partial<Pick<TenantProvisioningStore, "findByOrgId" | "markSucceeded">>;

interface SignupActivationStores {
  readonly orgs: Pick<OrgStore, "activateProvisionedOrg">;
  readonly provisioning: Pick<TenantProvisioningStore, "findByOrgId" | "markSucceeded">;
  readonly verificationTokens: SignupEmailVerificationTokenStore;
  readonly identities: SignupVerifiedIdentityStore;
  readonly sessionIssuer?: BetterAuthSessionIssuer;
  readonly outbox?: Pick<OutboxStore, "insert">;
}

function signupActivationStores(options: {
  readonly orgs?: SignupOrgStore;
  readonly provisioning?: SignupProvisioningStore;
  readonly verificationTokens?: SignupEmailVerificationTokenStore;
  readonly identities?: SignupVerifiedIdentityStore;
  readonly sessionIssuer?: BetterAuthSessionIssuer;
  readonly outbox?: Pick<OutboxStore, "insert">;
}): SignupActivationStores | null {
  if (
    options.orgs?.activateProvisionedOrg === undefined ||
    options.provisioning?.findByOrgId === undefined ||
    options.provisioning.markSucceeded === undefined ||
    options.verificationTokens === undefined ||
    options.identities === undefined
  ) {
    return null;
  }
  return {
    orgs: { activateProvisionedOrg: options.orgs.activateProvisionedOrg.bind(options.orgs) },
    provisioning: {
      findByOrgId: options.provisioning.findByOrgId.bind(options.provisioning),
      markSucceeded: options.provisioning.markSucceeded.bind(options.provisioning),
    },
    verificationTokens: options.verificationTokens,
    identities: options.identities,
    ...(options.sessionIssuer === undefined ? {} : { sessionIssuer: options.sessionIssuer }),
    ...(options.outbox === undefined ? {} : { outbox: options.outbox }),
  };
}

async function startSignupProvisioning(input: {
  readonly orgs: Pick<OrgStore, "createOrg">;
  readonly input: z.infer<typeof signupBodySchema>;
}): Promise<OrgRecord> {
  return input.orgs.createOrg({
    slug: input.input.orgSlug,
    displayName: input.input.orgName,
    status: "provisioning",
    tier: "personal",
    planId: "personal",
    region: "default",
  });
}

function signupMetadata(
  input: z.infer<typeof signupBodySchema>,
  riskReview: SignupRiskReviewDecision | undefined,
) {
  return {
    country: input.country,
    marketingOptIn: input.marketingOptIn,
    policies: {
      termsAccepted: input.termsAccepted,
      privacyAccepted: input.privacyAccepted,
    },
    ...(input.phone === undefined ? {} : { phone: input.phone }),
    ...(riskReview?.required === true
      ? {
          riskReview: {
            required: true,
            source: "signup_abuse_guard",
            country: riskReview.country,
            reasons: riskReview.reasons,
            smsGuidance: riskReview.smsGuidance,
          },
        }
      : {}),
  };
}

function publicSignupOrg(org: OrgRecord): {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly status: string;
  readonly region: string;
} {
  return {
    id: org.id,
    slug: org.slug,
    displayName: org.displayName,
    status: org.status,
    region: org.region,
  };
}

function sendSignupAbuseRejection(
  reply: FastifyReply,
  request: FastifyRequest,
  decision: Exclude<SignupAbuseCheckResult, { readonly allowed: true }>,
) {
  if (decision.reason === "rate_limited") {
    reply.header("retry-after", String(decision.retryAfterSeconds));
    return reply.code(429).send(
      buildErrorEnvelope({
        statusCode: 429,
        code: "signup_rate_limited",
        message: "Too many signup attempts from this IP address.",
        traceId: traceIdForRequest(request),
        details: {
          retryAfterSeconds: decision.retryAfterSeconds,
          rateLimit: {
            reason: "signups_per_ip",
            limit: decision.limit,
            windowSeconds: decision.windowSeconds,
          },
        },
      }),
    );
  }

  return reply.code(400).send(
    buildErrorEnvelope({
      statusCode: 400,
      code: "signup_email_domain_blocked",
      message: "That email domain is not accepted for self-service signup.",
      traceId: traceIdForRequest(request),
      details: {
        reason: "disposable_email_domain",
      },
    }),
  );
}

function sendSignupPasswordRejection(
  reply: FastifyReply,
  request: FastifyRequest,
  decision: Exclude<SignupPasswordScreeningResult, { readonly allowed: true }>,
) {
  if (decision.reason === "weak_password") {
    return reply.code(400).send(
      buildErrorEnvelope({
        statusCode: 400,
        code: "signup_password_weak",
        message: "Choose a stronger password before creating a workspace.",
        traceId: traceIdForRequest(request),
        details: {
          score: decision.score,
          minScore: decision.minScore,
        },
      }),
    );
  }

  if (decision.reason === "breached_password") {
    return reply.code(400).send(
      buildErrorEnvelope({
        statusCode: 400,
        code: "signup_password_breached",
        message: "Choose a password that has not appeared in a known breach.",
        traceId: traceIdForRequest(request),
        details: {
          reason: "known_breach",
        },
      }),
    );
  }

  return reply.code(503).send(
    buildErrorEnvelope({
      statusCode: 503,
      code: "signup_password_screening_unavailable",
      message: "Password safety checks are temporarily unavailable.",
      traceId: traceIdForRequest(request),
    }),
  );
}

function sendSignupRecaptchaRejection(
  reply: FastifyReply,
  request: FastifyRequest,
  decision: Exclude<SignupRecaptchaVerifyResult, { readonly allowed: true }>,
) {
  if (decision.reason === "verification_unavailable") {
    return reply.code(503).send(
      buildErrorEnvelope({
        statusCode: 503,
        code: "signup_recaptcha_unavailable",
        message: "Signup abuse checks are temporarily unavailable.",
        traceId: traceIdForRequest(request),
      }),
    );
  }

  return reply.code(400).send(
    buildErrorEnvelope({
      statusCode: 400,
      code: "signup_recaptcha_failed",
      message: "Signup abuse verification failed.",
      traceId: traceIdForRequest(request),
      details: {
        reason: decision.reason,
      },
    }),
  );
}

function validateOrgSlug(
  slug: string,
):
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: "invalid_format" | "reserved" } {
  const shape = orgSlugSchema.safeParse(slug);
  if (shape.success) {
    return { valid: true };
  }
  return {
    valid: false,
    reason: reservedOrgSlugs.has(slug) ? "reserved" : "invalid_format",
  };
}

async function enqueueSignupVerificationEmail(input: {
  readonly outbox: Pick<OutboxStore, "insert"> | undefined;
  readonly org: Pick<OrgRecord, "id" | "slug">;
  readonly email: string;
  readonly verification: SignupEmailVerificationIssueResult;
  readonly publicBaseUrl: string;
  readonly request: FastifyRequest;
}): Promise<void> {
  await input.outbox?.insert({
    subject: signupVerificationEmailSubject,
    payload: {
      orgId: input.org.id,
      orgSlug: input.org.slug,
      email: input.email,
      verificationUrl: buildSignupVerificationUrl(input.publicBaseUrl, input.verification.token),
      expiresAt: input.verification.expiresAt.toISOString(),
      source: "signup",
    },
    ...traceForOutbox(input.request),
  });
}

async function enqueueSignupRiskReviewRequested(input: {
  readonly outbox: Pick<OutboxStore, "insert"> | undefined;
  readonly org: Pick<OrgRecord, "id" | "slug">;
  readonly riskReview: SignupRiskReviewDecision | undefined;
  readonly request: FastifyRequest;
}): Promise<void> {
  if (input.riskReview?.required !== true) {
    return;
  }
  await input.outbox?.insert({
    subject: signupRiskReviewRequestedSubject,
    payload: {
      orgId: input.org.id,
      orgSlug: input.org.slug,
      source: "signup",
      riskReview: {
        required: true,
        country: input.riskReview.country,
        reasons: input.riskReview.reasons,
        smsGuidance: input.riskReview.smsGuidance,
      },
    },
    ...traceForOutbox(input.request),
  });
}

async function enqueueSignupActivationSloObserved(input: {
  readonly outbox: Pick<OutboxStore, "insert"> | undefined;
  readonly metrics: PlatformMetrics | undefined;
  readonly org: Pick<OrgRecord, "id" | "slug" | "tier" | "planId" | "region">;
  readonly provisioning: {
    readonly createdAt: Date;
    readonly completedSteps: readonly string[];
  };
  readonly succeededProvisioning: {
    readonly completedAt: Date | null;
    readonly completedSteps: readonly string[];
  };
  readonly request: FastifyRequest;
}): Promise<void> {
  const completedAt = input.succeededProvisioning.completedAt ?? new Date();
  const durationSeconds = signupActivationDurationSeconds(input.provisioning.createdAt, completedAt);
  await input.outbox?.insert({
    subject: signupActivationSloObservedSubject,
    payload: {
      orgId: input.org.id,
      orgSlug: input.org.slug,
      tier: input.org.tier,
      planId: input.org.planId,
      region: input.org.region,
      source: "signup",
      slo: "signup_activation",
      targetSeconds: signupActivationSloTargetSeconds,
      durationSeconds,
      withinTarget: durationSeconds <= signupActivationSloTargetSeconds,
      startedAt: input.provisioning.createdAt.toISOString(),
      completedAt: completedAt.toISOString(),
      completedStepCount: input.succeededProvisioning.completedSteps.length,
    },
      ...traceForOutbox(input.request),
  });
  input.metrics?.recordSignupActivationSlo({
    tier: input.org.tier,
    planId: input.org.planId,
    region: input.org.region,
    durationSeconds,
    withinTarget: durationSeconds <= signupActivationSloTargetSeconds,
  });
}

function signupActivationDurationSeconds(startedAt: Date, completedAt: Date): number {
  return Math.max(0, Math.round((completedAt.getTime() - startedAt.getTime()) / 1000));
}

function orgSlugFromSignupMetadata(metadata: Record<string, unknown>): string {
  return typeof metadata.orgSlug === "string" && metadata.orgSlug.trim().length > 0
    ? metadata.orgSlug
    : "workspace";
}

function compactRecord(input: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

async function enqueueSignupFunnelEvent(input: {
  readonly outbox: Pick<OutboxStore, "insert"> | undefined;
  readonly metrics: PlatformMetrics | undefined;
  readonly subject: string;
  readonly org: OrgRecord;
  readonly request: FastifyRequest;
  readonly payload: { readonly step: string } & Record<string, string>;
}): Promise<void> {
  await input.outbox?.insert({
    subject: input.subject,
    payload: {
      orgId: input.org.id,
      orgSlug: input.org.slug,
      tier: input.org.tier,
      planId: input.org.planId,
      region: input.org.region,
      ...input.payload,
    },
    ...traceForOutbox(input.request),
  });
  recordSignupFunnelMetric(input.metrics, {
    step: input.payload.step,
    org: input.org,
  });
}

function recordSignupFunnelMetric(
  metrics: PlatformMetrics | undefined,
  input: {
    readonly step: string;
    readonly org?: Pick<OrgRecord, "tier" | "planId" | "region"> | undefined;
  },
): void {
  metrics?.recordSignupFunnelEvent({
    step: input.step,
    ...(input.org === undefined
      ? {}
      : {
          tier: input.org.tier,
          planId: input.org.planId,
          region: input.org.region,
        }),
  });
}

export function buildSignupVerificationUrl(publicBaseUrl: string, token: string): string {
  const url = new URL("/signup/verify-email", publicBaseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

export function buildSignupOnboardingInviteUrl(
  publicBaseUrl: string,
  orgSlug: string,
  token: string,
): string {
  const url = new URL(buildSignupTenantUrl(publicBaseUrl, orgSlug, "/signup/invite"));
  url.searchParams.set("token", token);
  return url.toString();
}

export function buildSignupWorkspaceUrls(
  publicBaseUrl: string,
  orgSlug: string,
): {
  readonly onboardingUrl: string;
  readonly welcomeUrl: string;
} {
  return {
    onboardingUrl: buildSignupTenantUrl(publicBaseUrl, orgSlug, "/onboarding"),
    welcomeUrl: buildSignupTenantUrl(publicBaseUrl, orgSlug, "/welcome"),
  };
}

function buildSignupTenantUrl(publicBaseUrl: string, orgSlug: string, pathname: string): string {
  const url = new URL(pathname, publicBaseUrl);
  if (canUseTenantSubdomain(url.hostname)) {
    url.hostname = tenantHostname(url.hostname, orgSlug);
  }
  return url.toString();
}

function canUseTenantSubdomain(hostname: string): boolean {
  return (
    hostname.includes(".") &&
    hostname !== "localhost" &&
    hostname !== "[::1]" &&
    hostname !== "::1" &&
    !/^\d+\.\d+\.\d+\.\d+$/u.test(hostname)
  );
}

function tenantHostname(hostname: string, orgSlug: string): string {
  const labels = hostname.split(".");
  if (labels[0] === orgSlug) {
    return hostname;
  }
  if (labels.length > 2 && ["app", "www"].includes(labels[0] ?? "")) {
    return [orgSlug, ...labels.slice(1)].join(".");
  }
  return `${orgSlug}.${hostname}`;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "23505"
  );
}

function uniqueSteps(steps: readonly string[]): readonly string[] {
  return [...new Set(steps)];
}

function isUnauthenticated(actor: Actor): boolean {
  return actor.id === unauthenticatedActor.id && actor.orgId === unauthenticatedActor.orgId;
}

function canSendSignupOnboardingInvites(actor: Actor): boolean {
  const scopes = actor.scopes ?? [];
  return scopes.includes("admin.*") || scopes.includes("admin.users");
}

function traceForOutbox(
  request: FastifyRequest,
): Pick<Parameters<OutboxStore["insert"]>[0], "trace"> {
  const context = createRequestContext(request);
  if (context.traceId === undefined && context.spanId === undefined) {
    return {};
  }
  return {
    trace: {
      ...(context.traceId === undefined ? {} : { traceId: context.traceId }),
      ...(context.spanId === undefined ? {} : { spanId: context.spanId }),
    },
  };
}

function traceIdForRequest(request: FastifyRequest): string {
  const context = createRequestContext(request);
  return context.traceId ?? context.requestId;
}
