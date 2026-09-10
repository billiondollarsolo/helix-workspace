import type { Actor, MeteringClient } from "@helix/sdk-types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { unauthenticatedActor } from "../../api/actor.js";
import { buildErrorEnvelope } from "../../api/error-envelope.js";
import type { PlatformMetrics } from "../../api/metrics.js";
import { SIGNUP_BODY_LIMIT_BYTES } from "../../api/request-body.js";
import { createRequestContext } from "../../api/trace.js";
import type { BetterAuthSessionIssuer } from "../auth/better-auth.js";
import { emitSeatDelta } from "../metering/seat-events.js";
import type { OutboxStore } from "../outbox/outbox.js";
import type { OrgRecord, OrgStore, TenantProvisioningStore } from "../tenancy/index.js";
import {
  signupOnboardingInviteEmailSubject,
  signupVerificationEmailSubject,
} from "./email-delivery.js";
import { signupActivationSloObservedSubject, signupFunnelSubjects } from "./event-schemas.js";
import type { SignupOnboardingInviteTokenStore } from "./invites.js";
import type {
  SignupEmailVerificationIssueResult,
  SignupEmailVerificationTokenStore,
  SignupVerifiedIdentityStore,
} from "./verification.js";

interface InviteRouteDependencies {
  readonly orgs: Pick<OrgStore, "findById" | "activateProvisionedOrg">;
  readonly provisioning: Pick<TenantProvisioningStore, "findByOrgId" | "markSucceeded">;
  readonly verificationTokens: Required<SignupEmailVerificationTokenStore>;
  readonly identities: SignupVerifiedIdentityStore;
  readonly sessionIssuer?: BetterAuthSessionIssuer;
  readonly outbox: Pick<OutboxStore, "insert">;
  readonly publicBaseUrl: string;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly onboardingInvites: SignupOnboardingInviteTokenStore;
  readonly metering?: MeteringClient;
  readonly onMeteringError?: (error: unknown) => void;
  readonly metrics?: PlatformMetrics;
}

// Invite delivery and token verification remain available; no public account or workspace creation.
export async function registerInviteRoutes(
  app: FastifyInstance,
  options: InviteRouteDependencies,
): Promise<void> {
  const publicBaseUrl = options.publicBaseUrl;
  app.post(
    "/api/signup/verify-email",
    { bodyLimit: SIGNUP_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const parsed = verifyEmailBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendSignupBadRequest(
          reply,
          request,
          `Invalid signup verification request body: ${parsed.error.message}`,
        );
      }

      const tokenRecord = await options.verificationTokens.findValid({
        token: parsed.data.token,
      });
      if (tokenRecord === null) {
        return sendSignupError(reply, request, {
          statusCode: 400,
          code: "signup_verification_invalid",
          message: "Signup email verification token is invalid or expired.",
        });
      }

      const provisioning = await options.provisioning.findByOrgId(tokenRecord.orgId);
      if (provisioning?.status !== "waiting_for_verification") {
        const provisioningStatus = provisioning?.status ?? "missing";
        const currentStep = provisioning?.currentStep ?? null;
        return sendSignupError(reply, request, {
          statusCode: 409,
          code: "tenant_not_ready",
          message: "Tenant provisioning has not completed its pre-verification steps.",
          details: {
            status: provisioningStatus,
            currentStep,
          },
        });
      }

      const consumed = await options.verificationTokens.consume({ token: parsed.data.token });
      if (consumed === null) {
        return sendSignupError(reply, request, {
          statusCode: 400,
          code: "signup_verification_invalid",
          message: "Signup email verification token is invalid or expired.",
        });
      }

      const identity = await options.identities.createVerifiedCredentialUser({
        orgId: consumed.orgId,
        email: consumed.email,
        passwordHash: consumed.passwordHash,
      });
      if (identity === null) {
        return sendSignupError(reply, request, {
          statusCode: 409,
          code: "signup_identity_conflict",
          message: "Verified signup identity could not be linked to the tenant owner actor.",
        });
      }

      const org = await options.orgs.activateProvisionedOrg(consumed.orgId);
      if (org === null) {
        return sendSignupError(reply, request, {
          statusCode: 409,
          code: "tenant_activation_conflict",
          message: "Tenant could not be activated from its current status.",
        });
      }

      const succeededProvisioning = await options.provisioning.markSucceeded({
        orgId: org.id,
        currentStep: "email_verified",
        completedSteps: uniqueSteps([...provisioning.completedSteps, "email_verified"]),
      });
      await enqueueSignupActivationSloObserved({
        outbox: options.outbox,
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
      await options.outbox.insert({
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
        outbox: options.outbox,
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

      const session = await options.sessionIssuer?.issueSession({
        userId: identity.betterAuthUserId,
        requestHeaders: request.headers,
        ipAddress: request.ip,
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
        workspace: { workspaceUrl: new URL("/mail", publicBaseUrl).toString() },
      };
    },
  );

  app.post(
    "/api/signup/resend-verification",
    { bodyLimit: SIGNUP_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const parsed = resendVerificationBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendSignupBadRequest(
          reply,
          request,
          `Invalid signup verification resend request body: ${parsed.error.message}`,
        );
      }

      const reissue = await options.verificationTokens.reissueFromToken({
        token: parsed.data.token,
      });
      if (reissue.status === "rate_limited") {
        reply.header("retry-after", String(reissue.retryAfterSeconds));
        return sendSignupError(reply, request, {
          statusCode: 429,
          code: "signup_verification_resend_rate_limited",
          message: "Too many signup verification resend attempts.",
        });
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
          publicBaseUrl,
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
    },
  );

  app.post(
    "/api/signup/onboarding-invites",
    { bodyLimit: SIGNUP_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const parsed = onboardingInvitesBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendSignupBadRequest(
          reply,
          request,
          `Invalid signup onboarding invites request body: ${parsed.error.message}`,
        );
      }

      const actor = await options.actorFromRequest(request);
      if (isUnauthenticated(actor)) {
        return sendSignupUnauthorized(reply, request);
      }
      if (!canSendSignupOnboardingInvites(actor)) {
        return sendSignupError(reply, request, {
          statusCode: 403,
          code: "forbidden",
          message: "Admin access is required to invite teammates.",
        });
      }

      const org = await options.orgs.findById(actor.orgId);
      if (org === null) {
        return sendSignupError(reply, request, {
          statusCode: 409,
          code: "signup_onboarding_invites_org_not_found",
          message: "Invite delivery could not resolve the current workspace.",
        });
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
            inviteUrl: buildSignupOnboardingInviteUrl(publicBaseUrl, invite.token),
            source: "signup",
          },
          ...traceForOutbox(request),
        });
      }

      return reply.code(202).send({ status: "accepted", inviteCount: emails.length });
    },
  );

  app.post(
    "/api/signup/onboarding-invite/accept",
    { bodyLimit: SIGNUP_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const parsed = onboardingInviteAcceptBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendSignupBadRequest(
          reply,
          request,
          `Invalid signup onboarding invite acceptance request body: ${parsed.error.message}`,
        );
      }

      const actor = await options.actorFromRequest(request);
      if (isUnauthenticated(actor)) {
        return sendSignupUnauthorized(reply, request);
      }

      const acceptance = await options.onboardingInvites.accept({
        token: parsed.data.token,
        actor,
      });
      if (acceptance.status === "not_found") {
        return sendSignupError(reply, request, {
          statusCode: 400,
          code: "signup_onboarding_invite_invalid",
          message: "Signup onboarding invite is invalid or expired.",
        });
      }
      if (acceptance.status === "email_mismatch") {
        return sendSignupError(reply, request, {
          statusCode: 403,
          code: "signup_onboarding_invite_email_mismatch",
          message: "Sign in with the invited email address before accepting this invite.",
        });
      }

      const org = await options.orgs.findById(acceptance.invite.orgId);
      if (org === null) {
        return sendSignupError(reply, request, {
          statusCode: 409,
          code: "signup_onboarding_invite_org_not_found",
          message: "Invite acceptance could not resolve the invited workspace.",
        });
      }

      await options.outbox.insert({
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
        workspace: { workspaceUrl: new URL("/mail", publicBaseUrl).toString() },
      };
    },
  );
}

const verifyEmailBodySchema = z.object({
  token: z.string().min(1).max(4096),
});

const resendVerificationBodySchema = z.object({
  token: z.string().min(1).max(4096),
});

const onboardingInvitesBodySchema = z.object({
  emails: z.array(z.string().trim().toLowerCase().email()).min(1).max(10),
});

const onboardingInviteAcceptBodySchema = z.object({
  token: z.string().min(1).max(4096),
});

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
  const durationSeconds = signupActivationDurationSeconds(
    input.provisioning.createdAt,
    completedAt,
  );
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

export function buildSignupOnboardingInviteUrl(publicBaseUrl: string, token: string): string {
  const url = new URL("/signup/invite", publicBaseUrl);
  url.searchParams.set("token", token);
  return url.toString();
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

function sendSignupError(
  reply: FastifyReply,
  request: FastifyRequest,
  input: {
    readonly statusCode: number;
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  },
): FastifyReply {
  return reply.code(input.statusCode).send(
    buildErrorEnvelope({
      statusCode: input.statusCode,
      code: input.code,
      message: input.message,
      traceId: traceIdForRequest(request),
      ...(input.details === undefined ? {} : { details: input.details }),
    }),
  );
}

function sendSignupBadRequest(
  reply: FastifyReply,
  request: FastifyRequest,
  message: string,
): FastifyReply {
  return sendSignupError(reply, request, { statusCode: 400, code: "bad_request", message });
}

function sendSignupUnauthorized(reply: FastifyReply, request: FastifyRequest): FastifyReply {
  return sendSignupError(reply, request, {
    statusCode: 401,
    code: "unauthorized",
    message: "Authentication required.",
  });
}

function traceIdForRequest(request: FastifyRequest): string {
  const context = createRequestContext(request);
  return context.traceId ?? context.requestId;
}

const signupActivationSloTargetSeconds = 60;
