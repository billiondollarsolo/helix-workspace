import type { FastifyRequest } from "fastify";
import type { Actor } from "@helix/sdk-types";
import type { AccessTokenStore } from "../platform/auth/oauth.js";
import {
  authenticateApiKey,
  authenticateMtlsCertificate,
  enforceCredentialPolicy,
  isApiKey,
  type AgentCredentialPolicy,
  type AgentCredentialStore,
  type CredentialRequestContext,
} from "../platform/auth/credentials.js";
import {
  actorToolInvocationPrincipal,
  credentialToolInvocationPrincipal,
  type ToolInvocationPrincipal,
} from "../platform/auth/tool-invocation-principal.js";

export interface SessionActorResolver {
  resolve(request: FastifyRequest): Promise<Actor | null>;
}

/**
 * An {@link Actor} carrying the per-credential policy (PRD §9.2) resolved from
 * the credential that authenticated the request. Consumers use
 * {@link credentialPolicyOf} to read the policy and feed its
 * `confirmationOverride` / `rateLimitOverrides` into the tool registry.
 */
/** Read the credential policy attached to a resolved actor, if any. */
export function credentialPolicyOf(actor: Actor): AgentCredentialPolicy | undefined {
  return actorToolInvocationPrincipal(actor).credentialPolicy;
}

/** Result of API-key / mTLS authentication on the request path. */
export type CredentialResolution =
  | { readonly ok: true; readonly principal: ToolInvocationPrincipal }
  | {
      readonly ok: false;
      readonly statusCode: number;
      readonly code: string;
      readonly message: string;
    };

export type CredentialActorResolution =
  | { readonly ok: true; readonly actor: Actor }
  | Exclude<CredentialResolution, { readonly ok: true }>;

/**
 * Result of resolving any supported request authentication mechanism. Shaped
 * identically to {@link CredentialResolution}: the credential path's result is
 * returned directly when it authenticates the request.
 */
export type ToolInvocationPrincipalResolution = CredentialResolution;

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
      return actorFromAccessToken(accessToken);
    }
  }

  const sessionActor = await sessionResolver?.resolve(request);
  if (sessionActor !== undefined && sessionActor !== null) {
    return sessionActor;
  }

  return actorFromRequest(request);
}

/**
 * Resolve the complete tool principal for an HTTP request.
 *
 * API keys and mTLS credentials are authenticated directly. OAuth access
 * tokens are also joined back to their policy-bearing credential so a client
 * revocation or policy change takes effect immediately. Human sessions and the
 * trusted-header development fallback intentionally produce actor-only
 * principals.
 */
export async function toolInvocationPrincipalFromRequest(
  request: FastifyRequest,
  tokenStore: AccessTokenStore,
  sessionResolver?: SessionActorResolver,
  credentialStore?: AgentCredentialStore,
): Promise<ToolInvocationPrincipalResolution> {
  if (credentialStore !== undefined) {
    const credentialResolution = await resolveCredentialAuthenticatedPrincipal(
      request,
      credentialStore,
    );
    if (credentialResolution !== null) {
      return credentialResolution;
    }
  }

  const token = bearerTokenFromRequest(request);
  if (token !== undefined) {
    const accessToken = await tokenStore.findToken(token);
    if (accessToken !== null) {
      const actor = actorFromAccessToken(accessToken);
      if (credentialStore?.findByClientId !== undefined) {
        const credential = await credentialStore.findByClientId(accessToken.clientId);
        if (
          credential === null ||
          credential.credentialType !== "oauth_client" ||
          credential.clientId !== accessToken.clientId ||
          credential.actorId !== actor.id ||
          credential.orgId !== actor.orgId ||
          !accessToken.scopes.every((scope) => credential.scopes.includes(scope))
        ) {
          return {
            ok: false,
            statusCode: 403,
            code: "credential_revoked",
            message: "Credential has been revoked or no longer matches this access token.",
          };
        }
        const enforcement = enforceCredentialPolicy(credential, credentialRequestContext(request));
        if (!enforcement.ok) {
          return {
            ok: false,
            statusCode: 403,
            code: enforcement.code,
            message: enforcement.message,
          };
        }
        return { ok: true, principal: credentialPrincipalForActor(actor, credential) };
      }
      return { ok: true, principal: actorToolInvocationPrincipal(actor) };
    }
  }

  const sessionActor = await sessionResolver?.resolve(request);
  if (sessionActor !== undefined && sessionActor !== null) {
    return {
      ok: true,
      principal: actorToolInvocationPrincipal(sessionActor),
    };
  }

  return {
    ok: true,
    principal: actorToolInvocationPrincipal(actorFromRequest(request)),
  };
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
): Promise<CredentialActorResolution | null> {
  const resolution = await resolveCredentialAuthenticatedPrincipal(request, credentialStore);
  return resolution?.ok === true ? { ok: true, actor: resolution.principal.actor } : resolution;
}

/**
 * Authenticate an API-key or mTLS request and return its complete invocation
 * principal. The legacy actor-named export preserves its actor-only result for
 * non-tool callers.
 */
export async function resolveCredentialAuthenticatedPrincipal(
  request: FastifyRequest,
  credentialStore: AgentCredentialStore,
): Promise<CredentialResolution | null> {
  const context = credentialRequestContext(request);

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
    return { ok: true, principal: credentialPrincipal(result.credential) };
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
    return { ok: true, principal: credentialPrincipal(result.credential) };
  }

  return null;
}

/**
 * Attach a credential's identity and policy to an already-resolved actor.
 * Shared by API-key/mTLS authentication (which derives the actor from the
 * credential) and the OAuth path (which derives it from the access token).
 */
function credentialPrincipalForActor(
  actor: Actor,
  credential: {
    readonly id: string;
    readonly approvalOwnerActorId?: string | null;
    readonly policy: AgentCredentialPolicy;
  },
): ToolInvocationPrincipal {
  return credentialToolInvocationPrincipal({
    actor,
    credentialId: credential.id,
    ...(credential.approvalOwnerActorId === undefined
      ? {}
      : { credentialOwnerActorId: credential.approvalOwnerActorId }),
    credentialPolicy: credential.policy,
  });
}

function credentialPrincipal(credential: {
  readonly id: string;
  readonly actorId: string;
  readonly orgId: string;
  readonly scopes: readonly string[];
  readonly approvalOwnerActorId?: string | null;
  readonly policy: AgentCredentialPolicy;
}): ToolInvocationPrincipal {
  return credentialPrincipalForActor(
    {
      id: credential.actorId,
      orgId: credential.orgId,
      type: "agent",
      scopes: credential.scopes,
    },
    credential,
  );
}

function credentialRequestContext(request: FastifyRequest): CredentialRequestContext {
  return {
    ...(typeof request.ip === "string" && request.ip.length > 0 ? { ip: request.ip } : {}),
  };
}

function actorFromAccessToken(accessToken: {
  readonly actorId: string;
  readonly orgId: string;
  readonly actorType?: "user" | "agent" | "service_account" | "system";
  readonly actorDisplayName?: string;
  readonly actorEmail?: string;
  readonly scopes: readonly string[];
}): Actor {
  return {
    id: accessToken.actorId,
    orgId: accessToken.orgId,
    type: accessToken.actorType ?? "agent",
    scopes: accessToken.scopes,
    ...(accessToken.actorDisplayName === undefined
      ? {}
      : { displayName: accessToken.actorDisplayName }),
    ...(accessToken.actorEmail === undefined ? {} : { email: accessToken.actorEmail }),
  };
}

/** Extract the raw value of an `Authorization: Bearer <value>` header. */
function bearerHeaderValue(request: FastifyRequest): string | undefined {
  const authorization = firstHeaderValue(request.headers.authorization);
  if (authorization === undefined) {
    return undefined;
  }
  const [scheme, value] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || value === undefined || value.length === 0) {
    return undefined;
  }
  return value;
}

function apiKeyFromRequest(request: FastifyRequest): string | undefined {
  const explicit = firstHeaderValue(request.headers["x-api-key"]);
  if (explicit !== undefined && isApiKey(explicit)) {
    return explicit;
  }
  const bearer = bearerHeaderValue(request);
  if (bearer !== undefined && isApiKey(bearer)) {
    return bearer;
  }
  return undefined;
}

function clientCertFingerprintFromRequest(request: FastifyRequest): string | undefined {
  return firstHeaderValue(request.headers["x-helix-client-cert-fingerprint"]);
}

export function bearerTokenFromRequest(request: FastifyRequest): string | undefined {
  return bearerHeaderValue(request) ?? accessTokenFromQuery(request.query) ?? undefined;
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
