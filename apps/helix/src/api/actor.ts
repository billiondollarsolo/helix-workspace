import type { FastifyRequest } from "fastify";
import type { Actor } from "@helix/sdk-types";
import type { AccessTokenStore } from "../platform/auth/oauth.js";
import {
  authenticateApiKey,
  authenticateMtlsCertificate,
  isApiKey,
  type AgentCredentialPolicy,
  type AgentCredentialStore,
  type CredentialRequestContext,
} from "../platform/auth/credentials.js";

export interface SessionActorResolver {
  resolve(request: FastifyRequest): Promise<Actor | null>;
}

/**
 * An {@link Actor} carrying the per-credential policy (PRD §9.2) resolved from
 * the credential that authenticated the request. Consumers use
 * {@link credentialPolicyOf} to read the policy and feed its
 * `confirmationOverride` / `rateLimitOverrides` into the tool registry.
 */
const credentialPolicyByActor = new WeakMap<Actor, AgentCredentialPolicy>();

/** Read the credential policy attached to a resolved actor, if any. */
export function credentialPolicyOf(actor: Actor): AgentCredentialPolicy | undefined {
  return credentialPolicyByActor.get(actor);
}

/** Result of API-key / mTLS authentication on the request path. */
export type CredentialResolution =
  | { readonly ok: true; readonly actor: Actor }
  | { readonly ok: false; readonly statusCode: number; readonly code: string; readonly message: string };

export const systemActor: Actor = {
  id: "system",
  orgId: "00000000-0000-0000-0000-000000000000",
  type: "system",
  displayName: "System",
};

export const unauthenticatedActor: Actor = {
  id: "anonymous",
  orgId: "00000000-0000-0000-0000-000000000000",
  type: "agent",
  displayName: "Unauthenticated",
  scopes: [],
};

export function actorFromRequest(request: FastifyRequest): Actor {
  const actorId = firstHeaderValue(request.headers["x-helix-actor-id"]);
  const actorType = firstHeaderValue(request.headers["x-helix-actor-type"]);
  const orgId = firstHeaderValue(request.headers["x-helix-org-id"]);
  const scopes = parseScopes(firstHeaderValue(request.headers["x-helix-scopes"]));

  if (actorId === undefined || orgId === undefined) {
    return unauthenticatedActor;
  }

  return {
    id: actorId,
    orgId,
    type:
      actorType === "agent" || actorType === "service_account" || actorType === "user"
        ? actorType
        : "user",
    ...(scopes.length === 0 ? {} : { scopes }),
  };
}

export async function actorFromRequestWithAccessToken(
  request: FastifyRequest,
  tokenStore: AccessTokenStore,
): Promise<Actor> {
  return actorFromRequestWithAccessTokenAndSession(request, tokenStore);
}

export async function actorFromRequestWithAccessTokenAndSession(
  request: FastifyRequest,
  tokenStore: AccessTokenStore,
  sessionResolver?: SessionActorResolver,
): Promise<Actor> {
  const token = bearerTokenFromRequest(request);
  if (token !== undefined) {
    const accessToken = await tokenStore.findToken(token);
    if (accessToken !== null) {
      const actor: Actor = {
        id: accessToken.actorId,
        orgId: accessToken.orgId,
        type: accessToken.actorType ?? "agent",
        scopes: accessToken.scopes,
      };
      if (accessToken.actorDisplayName !== undefined) {
        return accessToken.actorEmail === undefined
          ? { ...actor, displayName: accessToken.actorDisplayName }
          : { ...actor, displayName: accessToken.actorDisplayName, email: accessToken.actorEmail };
      }
      return accessToken.actorEmail === undefined ? actor : { ...actor, email: accessToken.actorEmail };
    }
  }

  const sessionActor = await sessionResolver?.resolve(request);
  if (sessionActor !== undefined && sessionActor !== null) {
    return sessionActor;
  }

  return actorFromRequest(request);
}

/**
 * Resolve and authenticate an actor from an `api_key` or `mtls_cert`
 * credential (PRD §9.2), enforcing the credential's per-credential policy
 * fields — IP allowlist, allowed-hours window, mTLS fingerprint, expiry, and
 * revocation. Returns a failure describing the rejection when the credential
 * is missing, unknown, or fails policy enforcement.
 *
 * An API key is taken from the `Authorization: Bearer helix_ak_…` header or
 * the `x-api-key` header. A client certificate fingerprint is read from the
 * `x-helix-client-cert-fingerprint` header (set by the TLS terminator).
 */
export async function resolveCredentialAuthenticatedActor(
  request: FastifyRequest,
  credentialStore: AgentCredentialStore,
): Promise<CredentialResolution | null> {
  const context: CredentialRequestContext = {
    ...(typeof request.ip === "string" && request.ip.length > 0 ? { ip: request.ip } : {}),
  };

  const apiKey = apiKeyFromRequest(request);
  if (apiKey !== undefined) {
    const result = await authenticateApiKey(credentialStore, apiKey, context);
    if (!result.ok) {
      return {
        ok: false,
        statusCode: result.code === "invalid_api_key" ? 401 : 403,
        code: result.code,
        message: result.message,
      };
    }
    return { ok: true, actor: credentialActor(result.credential) };
  }

  const fingerprint = clientCertFingerprintFromRequest(request);
  if (fingerprint !== undefined) {
    const result = await authenticateMtlsCertificate(credentialStore, fingerprint, context);
    if (!result.ok) {
      return {
        ok: false,
        statusCode: result.code === "invalid_certificate" ? 401 : 403,
        code: result.code,
        message: result.message,
      };
    }
    return { ok: true, actor: credentialActor(result.credential) };
  }

  return null;
}

function credentialActor(credential: {
  readonly actorId: string;
  readonly orgId: string;
  readonly scopes: readonly string[];
  readonly policy: AgentCredentialPolicy;
}): Actor {
  const actor: Actor = {
    id: credential.actorId,
    orgId: credential.orgId,
    type: "agent",
    scopes: credential.scopes,
  };
  credentialPolicyByActor.set(actor, credential.policy);
  return actor;
}

function apiKeyFromRequest(request: FastifyRequest): string | undefined {
  const explicit = firstHeaderValue(request.headers["x-api-key"]);
  if (explicit !== undefined && isApiKey(explicit)) {
    return explicit;
  }
  const authorization = firstHeaderValue(request.headers.authorization);
  if (authorization !== undefined) {
    const [scheme, value] = authorization.split(" ");
    if (scheme?.toLowerCase() === "bearer" && value !== undefined && isApiKey(value)) {
      return value;
    }
  }
  return undefined;
}

function clientCertFingerprintFromRequest(request: FastifyRequest): string | undefined {
  return firstHeaderValue(request.headers["x-helix-client-cert-fingerprint"]);
}

export function bearerTokenFromRequest(request: FastifyRequest): string | undefined {
  const authorization = firstHeaderValue(request.headers.authorization);
  if (authorization !== undefined) {
    const [scheme, token] = authorization.split(" ");
    if (scheme?.toLowerCase() === "bearer" && token !== undefined && token.length > 0) {
      return token;
    }
  }

  const queryToken = accessTokenFromQuery(request.query);
  return queryToken ?? undefined;
}

function parseScopes(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }
  return [...new Set(value.split(/[,\s]+/u).filter(Boolean))];
}

function firstHeaderValue(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return value?.[0];
}

function accessTokenFromQuery(query: unknown): string | null {
  if (typeof query !== "object" || query === null || !("access_token" in query)) {
    return null;
  }
  const value = (query as { readonly access_token?: unknown }).access_token;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    const trimmed = value[0].trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  return null;
}
