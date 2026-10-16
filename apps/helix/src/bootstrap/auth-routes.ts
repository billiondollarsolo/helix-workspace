import type { Actor } from "@helix/sdk-types";
import { type FastifyInstance } from "fastify";
import type { SessionActorResolver } from "../api/actor.js";
import { isRecord } from "../platform/util/json.js";
import {
  type BetterAuthInstance,
  type BetterAuthSessionVerifier,
} from "../platform/auth/better-auth.js";
import { createBetterAuthRequest } from "../platform/auth/better-auth-request.js";
import type { ExternalEmailMfa } from "../platform/auth/external-email-mfa.js";
import { type PostgresDomainIdentityStore } from "../platform/auth/domain-identity.js";
import {
  authResponseSessionToken,
  type PostgresRecoveryCodeBroker,
  verifiedMfaSessionToken,
  type MfaAssuranceMarker,
} from "../platform/auth/mfa.js";

export function registerBetterAuthRoutes(
  app: FastifyInstance,
  auth: BetterAuthInstance | undefined,
  mfaAssurance?: MfaAssuranceMarker,
  domainIdentity?: Pick<PostgresDomainIdentityStore, "canonicalize">,
  recoveryCodes?: PostgresRecoveryCodeBroker,
  sessionVerifier?: BetterAuthSessionVerifier,
  sessionActorResolver?: SessionActorResolver,
  emailMfa?: ExternalEmailMfa,
): void {
  if (auth === undefined) {
    return;
  }
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const path = request.url.split("?")[0] ?? "";
      const sessionUser = await sessionVerifier?.getSessionUser({ headers: request.headers });
      const sessionToken = await sessionVerifier?.getSessionToken?.({ headers: request.headers });
      let requestBody = request.body;
      if (
        request.method === "POST" &&
        path === "/api/auth/sign-in/email" &&
        request.tenant !== null &&
        typeof request.body === "object" &&
        request.body !== null &&
        "email" in request.body &&
        typeof request.body.email === "string" &&
        domainIdentity !== undefined
      ) {
        const email = await domainIdentity.canonicalize(request.tenant.orgId, request.body.email);
        if (email === null) {
          return reply.code(403).send({ message: "Sign-in is unavailable for this domain." });
        }
        requestBody = { ...request.body, email };
      }
      if (
        recoveryCodes !== undefined &&
        (path === "/api/auth/passkey/generate-register-options" ||
          path === "/api/auth/passkey/verify-registration" ||
          path === "/api/auth/passkey/delete-passkey") &&
        (sessionToken === null ||
          sessionToken === undefined ||
          !(await recoveryCodes.isRecentSession(sessionToken)))
      ) {
        return reply.code(403).send({ code: "recent_authentication_required" });
      }
      if (
        recoveryCodes !== undefined &&
        path === "/api/auth/two-factor/verify-backup-code" &&
        typeof requestBody === "object" &&
        requestBody !== null &&
        "code" in requestBody &&
        typeof requestBody.code === "string"
      ) {
        const bridge = await recoveryCodes.consume(requestBody.code);
        requestBody = { ...requestBody, code: bridge ?? "invalid-recovery-code" };
      }
      if (
        path === "/api/auth/two-factor/enable" &&
        isRecord(requestBody) &&
        requestBody.method === "otp"
      ) {
        return reply
          .code(400)
          .send({ message: "Verify and enable your external email in Security settings first." });
      }
      const operation = () => auth.handler(createBetterAuthRequest(request, { body: requestBody }));
      const response =
        emailMfa === undefined ? await operation() : await emailMfa.handleAuth(operation);
      let body = response.body === null ? null : await response.text();
      if (
        response.ok &&
        path === "/api/auth/sign-in/email" &&
        emailMfa !== undefined &&
        isRecord(requestBody) &&
        typeof requestBody.email === "string"
      ) {
        const payload = jsonRecord(body);
        if (payload?.twoFactorRedirect === true && Array.isArray(payload.twoFactorMethods)) {
          const emailAvailable = await emailMfa.availableForEmail(requestBody.email);
          body = JSON.stringify({
            ...payload,
            twoFactorMethods: payload.twoFactorMethods.filter(
              (method) => method !== "otp" || emailAvailable,
            ),
          });
        }
      }
      if (response.ok && path === "/api/auth/get-session" && request.tenant != null) {
        const payload = jsonRecord(body);
        if (isRecord(payload?.user)) {
          const actor = await sessionActorResolver?.resolve(request);
          if (actor?.type === "user" && actor.orgId === request.tenant.orgId) {
            const factors =
              emailMfa === undefined || typeof payload.user.id !== "string"
                ? null
                : await emailMfa.status(payload.user.id, false);
            body = JSON.stringify({
              ...payload,
              user: {
                ...payload.user,
                name: actor.displayName,
                actorId: actor.id,
                orgId: actor.orgId,
                scopes: sessionScopes(actor),
                ...(factors === null
                  ? {}
                  : { totpEnabled: factors.totpEnabled, emailOtpEnabled: factors.enabled }),
              },
            });
          }
        }
      }
      if (
        response.ok &&
        recoveryCodes !== undefined &&
        sessionUser !== null &&
        sessionUser !== undefined &&
        (path === "/api/auth/two-factor/enable" ||
          path === "/api/auth/two-factor/generate-backup-codes")
      ) {
        const payload = jsonRecord(body);
        const bridgeCodes = payload?.backupCodes;
        if (
          payload !== null &&
          Array.isArray(bridgeCodes) &&
          bridgeCodes.every((code): code is string => typeof code === "string")
        ) {
          body = JSON.stringify({
            ...payload,
            backupCodes: await recoveryCodes.replace(sessionUser.id, bridgeCodes),
          });
        }
      }
      if (
        response.ok &&
        recoveryCodes !== undefined &&
        sessionUser !== null &&
        sessionUser !== undefined &&
        path === "/api/auth/two-factor/disable"
      ) {
        await recoveryCodes.clear(sessionUser.id);
        await emailMfa?.retainEmailFactor(sessionUser.id);
      }
      const verifiedSessionToken = verifiedMfaSessionToken(
        request.url,
        response.status,
        body,
        response.headers.get("set-cookie"),
      );
      const issuedSessionToken = authResponseSessionToken(body, response.headers.get("set-cookie"));
      if (
        verifiedSessionToken !== null &&
        !(await mfaAssurance?.markVerifiedSession(verifiedSessionToken))
      ) {
        throw new Error("Verified MFA session could not be bound to server-side assurance.");
      }
      if (
        response.ok &&
        recoveryCodes !== undefined &&
        sessionUser !== null &&
        sessionUser !== undefined &&
        FACTOR_MUTATION_PATHS.has(path)
      ) {
        await recoveryCodes.invalidateOtherSessions(
          sessionUser.id,
          issuedSessionToken ?? sessionToken ?? null,
        );
      }
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key !== "content-length") reply.header(key, value);
      });
      return reply.send(body);
    },
  });
}

const FACTOR_MUTATION_PATHS = new Set([
  "/api/auth/two-factor/enable",
  "/api/auth/two-factor/disable",
  "/api/auth/two-factor/verify-totp",
  "/api/auth/two-factor/verify-otp",
  "/api/auth/two-factor/generate-backup-codes",
  "/api/auth/passkey/verify-registration",
  "/api/auth/passkey/delete-passkey",
]);

function jsonRecord(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The permissions the signed-in actor holds org-wide: direct scopes plus
 * org-scoped role grants, less org-scoped denials. The web shell reads these
 * only to decide which entry points to show (the Admin console is offered to
 * admins alone); every request is still authorized server-side.
 */
function sessionScopes(actor: Actor): readonly string[] {
  const orgBindings = (actor.roleBindings ?? []).filter((binding) => binding.scope.type === "org");
  const denied = new Set(orgBindings.flatMap((binding) => binding.deny));
  return [
    ...new Set([...(actor.scopes ?? []), ...orgBindings.flatMap((binding) => binding.allow)]),
  ].filter((scope) => !denied.has(scope));
}
