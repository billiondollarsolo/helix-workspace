import { fromNodeHeaders } from "better-auth/node";
import { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  type BetterAuthInstance,
  type BetterAuthSessionVerifier,
} from "../platform/auth/better-auth.js";
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
      const response = await auth.handler(createBetterAuthRequest(request, requestBody));
      let body = response.body === null ? null : await response.text();
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

function createBetterAuthRequest(request: FastifyRequest, body = request.body): Request {
  const url = new URL(request.url, `${request.protocol}://${request.hostname}`);
  const headers = fromNodeHeaders(request.headers);
  for (const name of [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
  ]) {
    headers.delete(name);
  }
  headers.set("x-forwarded-for", request.ip);
  headers.set("x-forwarded-host", request.hostname);
  headers.set("x-forwarded-proto", request.protocol);
  headers.delete("content-length");
  const init: RequestInit = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD" && body !== undefined) {
    init.body = requestBodyForFetch(body);
  }
  return new Request(url, init);
}

function requestBodyForFetch(body: unknown): NonNullable<RequestInit["body"]> {
  if (typeof body === "string" || body instanceof Blob || body instanceof FormData) {
    return body;
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return body as NonNullable<RequestInit["body"]>;
  }
  return JSON.stringify(body);
}
