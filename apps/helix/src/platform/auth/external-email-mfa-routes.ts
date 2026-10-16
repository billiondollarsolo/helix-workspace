import {
  accountEmailCodeSchema,
  accountEmailFactorToggleSchema,
  accountExternalEmailVerificationSchema,
} from "@helix/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SessionActorResolver } from "../../api/actor.js";
import { BadRequestError, ForbiddenError, UnauthorizedError } from "../../api/api-error.js";
import { auditAdminAction, type AdminConsoleAuditSink } from "../admin/console-shared.js";
import { assertActorMatchesRequestTenant } from "../tenancy/middleware.js";
import type { BetterAuthInstance, BetterAuthSessionVerifier } from "./better-auth.js";
import { createBetterAuthRequest } from "./better-auth-request.js";
import type { ExternalEmailMfa } from "./external-email-mfa.js";
import type { PostgresRecoveryCodeBroker } from "./mfa.js";

export function registerExternalEmailMfaRoutes(
  app: FastifyInstance,
  options: {
    readonly auth: BetterAuthInstance;
    readonly verifier: BetterAuthSessionVerifier;
    readonly actors: SessionActorResolver | undefined;
    readonly factors: Pick<
      ExternalEmailMfa,
      "status" | "beginVerification" | "verifyAddress" | "setEnabled"
    >;
    readonly recoveryCodes: Pick<PostgresRecoveryCodeBroker, "invalidateOtherSessions"> | undefined;
    readonly audit: AdminConsoleAuditSink;
  },
): void {
  const person = async (request: FastifyRequest) => {
    const actor = await options.actors?.resolve(request);
    const user = await options.verifier.getSessionUser({ headers: request.headers });
    if (!actor || actor.id === "anonymous" || !user)
      throw new UnauthorizedError("Sign in to manage email verification.");
    assertActorMatchesRequestTenant(request, actor);
    if (actor.type !== "user" || !user.email)
      throw new ForbiddenError("Email verification is available to signed-in people.");
    return { actor, user, email: user.email };
  };
  const password = async (request: FastifyRequest, value: string) => {
    const response = await options.auth.handler(
      createBetterAuthRequest(request, {
        method: "POST",
        path: "/api/auth/verify-password",
        body: { password: value },
      }),
    );
    if (!response.ok) throw new BadRequestError("Your current password is incorrect.");
  };
  const changed = async (request: FastifyRequest, verb: string) => {
    const { actor, user } = await person(request);
    const token = await options.verifier.getSessionToken?.({ headers: request.headers });
    await options.recoveryCodes?.invalidateOtherSessions(user.id, token ?? null);
    await auditAdminAction(options.audit, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb,
      objectType: "actor",
      objectId: actor.id,
      metadata: {},
    });
  };

  app.get("/api/account/email-mfa", async (request) => {
    const { user } = await person(request);
    return options.factors.status(user.id);
  });
  app.post("/api/account/email-mfa/verification", async (request) => {
    const { user, email } = await person(request);
    const body = accountExternalEmailVerificationSchema.safeParse(request.body);
    if (!body.success)
      throw new BadRequestError("Enter an external email address and your current password.");
    await password(request, body.data.password);
    await options.factors.beginVerification(user.id, body.data.email, email);
    return { sent: true };
  });
  app.post("/api/account/email-mfa/verification/confirm", async (request) => {
    const { user } = await person(request);
    const body = accountEmailCodeSchema.safeParse(request.body);
    if (!body.success)
      throw new BadRequestError("Enter the six-digit code from your external inbox.");
    await options.factors.verifyAddress(user.id, body.data.code);
    await changed(request, "account.external_email.verified");
    return options.factors.status(user.id);
  });
  app.post("/api/account/email-mfa/enabled", async (request) => {
    const { user } = await person(request);
    const body = accountEmailFactorToggleSchema.safeParse(request.body);
    if (!body.success) throw new BadRequestError("Confirm with your current password.");
    await password(request, body.data.password);
    await options.factors.setEnabled(user.id, body.data.enabled);
    await changed(
      request,
      body.data.enabled ? "account.email_mfa.enabled" : "account.email_mfa.disabled",
    );
    return options.factors.status(user.id);
  });
}
