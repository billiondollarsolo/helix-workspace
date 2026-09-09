import { createHash } from "node:crypto";
import { TLSSocket } from "node:tls";
import type { FastifyRequest } from "fastify";
import type { Actor } from "@helix/sdk-types";
import type { AccessTokenStore } from "../platform/auth/oauth.js";
import { validatedPermissions } from "../platform/permissions/scope-catalog.js";
import { limitRoleBindings } from "../platform/permissions/roles.js";
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
  | {
      readonly ok: false;
      readonly statusCode: number;
      readonly code: string;
      readonly message: string;
    };

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

const RESERVED_IDENTITY_HEADERS = [
  "x-helix-actor-id",
  "x-helix-actor-type",
  "x-helix-org-id",
  "x-helix-scopes",
  "x-helix-mfa-verified",
  "x-helix-client-cert-fingerprint",
] as const;

/** Return the first client-controlled identity assertion header, if present. */
export function untrustedIdentityHeader(
  headers: FastifyRequest["headers"],
): (typeof RESERVED_IDENTITY_HEADERS)[number] | undefined {
  return RESERVED_IDENTITY_HEADERS.find((name) => headers[name] !== undefined);
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
      const scopes = validatedPermissions(accessToken.scopes);
      const roleBindings = limitRoleBindings(accessToken.roleBindings ?? [], scopes);
      const actor: Actor = {
        id: accessToken.actorId,
        orgId: accessToken.orgId,
        type: accessToken.actorType ?? "agent",
        scopes,
        ...(roleBindings.length === 0 ? {} : { roleBindings }),
      };
      if (accessToken.actorDisplayName !== undefined) {
        return accessToken.actorEmail === undefined
          ? { ...actor, displayName: accessToken.actorDisplayName }
          : { ...actor, displayName: accessToken.actorDisplayName, email: accessToken.actorEmail };
      }
      return accessToken.actorEmail === undefined
        ? actor
        : { ...actor, email: accessToken.actorEmail };
    }
  }

  const sessionActor = await sessionResolver?.resolve(request);
  if (sessionActor !== undefined && sessionActor !== null) {
    return sessionActor;
  }

  return unauthenticatedActor;
}

/**
 * Resolve and authenticate an actor from an `api_key` or `mtls_cert`
 * credential (PRD §9.2), enforcing the credential's per-credential policy
 * fields — IP allowlist, allowed-hours window, mTLS fingerprint, expiry, and
 * revocation. Returns a failure describing the rejection when the credential
 * is missing, unknown, or fails policy enforcement.
 *
 * An API key is taken from the `Authorization: Bearer helix_ak_…` header or
 * the `x-api-key` header. A client certificate fingerprint is derived only
 * from a certificate authenticated by the request's TLS socket.
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

  if (firstHeaderValue(request.headers["x-helix-client-cert-fingerprint"]) !== undefined) {
    return {
      ok: false,
      statusCode: 401,
      code: "invalid_certificate",
      message: "Client certificate authentication requires a verified TLS peer certificate.",
    };
  }

  return null;
}

function credentialActor(credential: {
  readonly actorId: string;
  readonly orgId: string;
  readonly scopes: readonly string[];
  readonly roleBindings?: Actor["roleBindings"];
  readonly policy: AgentCredentialPolicy;
}): Actor {
  const scopes = validatedPermissions(credential.scopes);
  const roleBindings = limitRoleBindings(credential.roleBindings ?? [], scopes);
  const actor: Actor = {
    id: credential.actorId,
    orgId: credential.orgId,
    type: "agent",
    scopes,
    ...(roleBindings.length === 0 ? {} : { roleBindings }),
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
  const socket = request.raw.socket;
  if (!(socket instanceof TLSSocket) || !socket.authorized) {
    return undefined;
  }
  const certificate = socket.getPeerCertificate();
  if (!Buffer.isBuffer(certificate.raw) || certificate.raw.length === 0) {
    return undefined;
  }
  return createHash("sha256").update(certificate.raw).digest("hex");
}

export function bearerTokenFromRequest(request: FastifyRequest): string | undefined {
  const authorization = firstHeaderValue(request.headers.authorization);
  if (authorization !== undefined) {
    const [scheme, token] = authorization.split(" ");
    if (scheme?.toLowerCase() === "bearer" && token !== undefined && token.length > 0) {
      return token;
    }
  }
  return undefined;
}

function firstHeaderValue(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return value?.[0];
}
