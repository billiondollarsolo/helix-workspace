import type { Actor, JsonObject } from "@helix/sdk-types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { OAUTH_BODY_LIMIT_BYTES } from "../../api/request-body.js";
import { actorHasScope } from "../../api/scopes.js";
import { HELIX_API_VERSION_PREFIX } from "../../api/version.js";
import { getCryptoProvider, sha256Hex } from "../crypto/index.js";
import { parseBasicAuthorization } from "../util/http-auth.js";
import { type AuthorizationCodeService, isValidCodeChallenge } from "./authorization-code.js";
import type { OAuthAuthorizationStore } from "./authorization-store.js";
import {
  type OAuthClientRecord,
  type OAuthClientStore,
  OAuthError,
  type OAuthTokenService,
} from "./oauth.js";

const tokenRequestBodySchema = z.object({
  grant_type: z.string(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  scope: z.string().optional(),
  code: z.string().optional(),
  redirect_uri: z.string().optional(),
  code_verifier: z.string().optional(),
  refresh_token: z.string().optional(),
});

const tokenManagementBodySchema = z.object({
  token: z.string().optional(),
  token_type_hint: z.string().optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
});

const authorizeQuerySchema = z.object({
  response_type: z.string(),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  code_challenge: z.string().min(1),
  code_challenge_method: z.string().optional(),
  scope: z.string().optional(),
  state: z.string().optional(),
});

const authorizeDecisionBodySchema = z
  .object({
    consent_token: z.string().min(1).max(8192),
    decision: z.enum(["approve", "deny"]),
  })
  .strict();

/**
 * Resolves the authenticated end-user for the consent screen. When omitted,
 * the Authorization Code endpoints are disabled (they require a logged-in
 * user to approve a grant).
 */
export interface OAuthAuthorizeActorResolver {
  resolve(request: FastifyRequest): Promise<Actor | null>;
}

/**
 * Hook for emitting audit records when an authorization request is rejected
 * (CRITICAL-3). Implementations should be best-effort — a failure here MUST
 * NOT propagate, since the security decision has already been made.
 */
interface OAuthAuthorizeAuditSink {
  recordRejection(input: {
    readonly orgId: string | null;
    readonly actorId: string | null;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly reason: OAuthAuthorizeRejectionReason;
    readonly metadata?: JsonObject;
  }): Promise<void>;
}

type OAuthAuthorizeRejectionReason =
  | "access_denied"
  | "client_expired"
  | "client_revoked"
  | "code_issue_failed"
  | "invalid_request"
  | "invalid_scope"
  | "installation_not_approved"
  | "login_required"
  | "pkce_plain"
  | "redirect_uri_mismatch"
  | "tenant_mismatch"
  | "unknown_client";

export interface OAuthRoutesOptions {
  /** Canonical externally reachable issuer origin used for discovery. */
  readonly issuer: string;
  /** Durable production services are explicit; there is no hidden in-memory fallback. */
  readonly tokenService: OAuthTokenService;
  /**
   * Authorization-code service (PRD §13.6). When provided alongside
   * {@link actorResolver}, `/oauth/authorize` and the `authorization_code`
   * token grant are enabled.
   */
  readonly authorizationCodeService?: AuthorizationCodeService;
  /** Durable consent-nonce, install-policy, and grant store. */
  readonly authorizationStore?: OAuthAuthorizationStore;
  /** At least 32 bytes of server-only entropy used to bind consent fields. */
  readonly consentSecret?: string;
  /** Resolves the logged-in user that approves a consent request. */
  readonly actorResolver?: OAuthAuthorizeActorResolver;
  /**
   * OAuth client store used to resolve the requested client during the
   * authorize flow (CRITICAL-3). The endpoint reads the client's registered
   * `redirectUris` allowlist and requires an exact-string match with the
   * incoming `redirect_uri`. When omitted, the routes fall back to the same
   * store the {@link tokenService} uses, so callers wiring a real Postgres
   * store typically need not set this explicitly.
   */
  readonly clientStore: OAuthClientStore;
  /**
   * Optional audit sink that receives a record every time `/oauth/authorize`
   * rejects a request (CRITICAL-3). Wired to the platform audit log in the
   * production server.
   */
  readonly authorizeAuditSink?: OAuthAuthorizeAuditSink;
  /**
   * Optional override for where the consent UI lives. When set,
   * `GET /oauth/authorize` redirects the browser to this path with the
   * authorization-request parameters preserved, instead of rendering the
   * built-in server-side consent page.
   */
  readonly consentPagePath?: string;
}

export async function registerOAuthRoutes(
  app: FastifyInstance,
  options: OAuthRoutesOptions,
): Promise<void> {
  registerUrlEncodedParser(app);

  const { tokenService, clientStore, authorizationCodeService } = options;
  const issuer = normalizeIssuer(options.issuer);
  if (options.actorResolver !== undefined && authorizationCodeService === undefined) {
    throw new Error("OAuth authorization routes require a durable authorization-code service.");
  }
  if (options.actorResolver !== undefined && options.authorizeAuditSink === undefined) {
    throw new Error("OAuth authorization routes require an audit sink.");
  }
  if (options.actorResolver !== undefined && options.authorizationStore === undefined) {
    throw new Error("OAuth authorization routes require a durable authorization store.");
  }
  if (options.actorResolver !== undefined && (options.consentSecret?.length ?? 0) < 32) {
    throw new Error("OAuth authorization routes require a consent secret of at least 32 bytes.");
  }
  const authorizeAuditSink = options.authorizeAuditSink;

  app.get("/.well-known/oauth-authorization-server", async (_request, reply) =>
    reply.header("cache-control", "public, max-age=3600").send({
      issuer,
      authorization_endpoint: `${issuer}${HELIX_API_VERSION_PREFIX}/oauth/authorize`,
      token_endpoint: `${issuer}${HELIX_API_VERSION_PREFIX}/oauth/token`,
      revocation_endpoint: `${issuer}${HELIX_API_VERSION_PREFIX}/oauth/revoke`,
      introspection_endpoint: `${issuer}${HELIX_API_VERSION_PREFIX}/oauth/introspect`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    }),
  );

  app.post("/oauth/token", { bodyLimit: OAUTH_BODY_LIMIT_BYTES }, async (request, reply) => {
    const parsedBody = tokenRequestBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return sendOAuthError(
        reply,
        new OAuthError("invalid_request", "Invalid token request body.", 400),
      );
    }

    const grantType = parsedBody.data.grant_type;
    if (grantType === "client_credentials") {
      return handleClientCredentialsGrant(request, reply, tokenService, parsedBody.data);
    }
    if (grantType === "authorization_code") {
      return handleAuthorizationCodeGrant(request, reply, tokenService, parsedBody.data);
    }
    if (grantType === "refresh_token") {
      return handleRefreshTokenGrant(request, reply, tokenService, parsedBody.data);
    }
    return sendOAuthError(
      reply,
      new OAuthError(
        "unsupported_grant_type",
        "Only authorization_code, client_credentials, and refresh_token are supported.",
        400,
      ),
    );
  });

  // OAuth 2.1 Authorization Code flow with PKCE (PRD §13.6).
  // GET renders the consent screen; POST records the user's decision and,
  // on approval, issues a single-use authorization code.
  app.get("/oauth/authorize", async (request, reply) => {
    const parsedQuery = authorizeQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      await auditMalformedAuthorizeRequest(authorizeAuditSink, request.query);
      return sendOAuthError(
        reply,
        new OAuthError("invalid_request", "Invalid authorization request.", 400),
      );
    }
    const validation = validateAuthorizeParams(parsedQuery.data);
    if (validation instanceof OAuthError) {
      await auditAuthorizeValidationFailure(authorizeAuditSink, parsedQuery.data, validation);
      return sendOAuthError(reply, validation);
    }

    const actor = await resolveAuthorizeActor(request, reply, options, validation);
    if (actor === null) {
      return reply;
    }
    const authorizationStore = options.authorizationStore;
    const consentSecret = options.consentSecret;
    if (authorizationStore === undefined || consentSecret === undefined) {
      throw new Error("OAuth authorization runtime is incomplete.");
    }

    const clientGuard = await checkAuthorizeClient({
      clientStore,
      authorizationStore,
      validation,
      auditSink: authorizeAuditSink,
      actor,
    });
    if (clientGuard !== null) {
      return sendAuthorizeRejection(reply, clientGuard);
    }
    const consentToken = await issueConsentToken(
      consentSecret,
      authorizationStore,
      validation,
      actor,
    );

    if (options.consentPagePath !== undefined) {
      const target = `${options.consentPagePath}?${authorizeParamsToQuery(validation, consentToken)}`;
      return reply.code(302).header("location", target).send();
    }

    return reply
      .code(200)
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .send(renderConsentPage(validation, actor, consentToken));
  });

  app.post("/oauth/authorize", { bodyLimit: OAUTH_BODY_LIMIT_BYTES }, async (request, reply) => {
    const parsedBody = authorizeDecisionBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      await auditMalformedAuthorizeRequest(authorizeAuditSink, request.body);
      return sendOAuthError(
        reply,
        new OAuthError("invalid_request", "Invalid authorization decision.", 400),
      );
    }
    const authorizationStore = options.authorizationStore;
    const consentSecret = options.consentSecret;
    if (authorizationStore === undefined || consentSecret === undefined) {
      return sendOAuthError(
        reply,
        new OAuthError("invalid_request", "Authorization Code flow is not enabled.", 400),
      );
    }
    const consent = verifyConsentToken(consentSecret, parsedBody.data.consent_token);
    if (consent === null) {
      await auditMalformedAuthorizeRequest(authorizeAuditSink, request.body);
      return sendOAuthError(
        reply,
        new OAuthError("invalid_request", "Consent request is invalid or expired.", 400),
      );
    }
    const { validation } = consent;

    const actor = await resolveAuthorizeActor(request, reply, options, validation);
    if (actor === null) {
      return reply;
    }
    if (actor.id !== consent.actorId || actor.orgId !== consent.orgId) {
      await safeAuditRejection(authorizeAuditSink, {
        orgId: actor.orgId,
        actorId: actor.id,
        clientId: validation.clientId,
        redirectUri: validation.redirectUri,
        reason: "tenant_mismatch",
        metadata: { error: "consent_actor_mismatch" },
      });
      return sendOAuthError(
        reply,
        new OAuthError("invalid_request", "Consent request belongs to another session.", 400),
      );
    }
    const consumed = await authorizationStore.consumeConsentNonce(
      {
        nonceHash: sha256Hex(consent.nonce),
        clientId: validation.clientId,
        actorId: actor.id,
        orgId: actor.orgId,
        expiresAt: new Date(consent.expiresAt),
      },
      new Date(),
    );
    if (!consumed) {
      await safeAuditRejection(authorizeAuditSink, {
        orgId: actor.orgId,
        actorId: actor.id,
        clientId: validation.clientId,
        redirectUri: validation.redirectUri,
        reason: "invalid_request",
        metadata: { error: "consent_nonce_reused" },
      });
      return sendOAuthError(
        reply,
        new OAuthError("invalid_request", "Consent request is invalid or already used.", 400),
      );
    }

    const clientGuard = await checkAuthorizeClient({
      clientStore,
      authorizationStore,
      validation,
      auditSink: authorizeAuditSink,
      actor,
    });
    if (clientGuard !== null) {
      return sendAuthorizeRejection(reply, clientGuard);
    }

    if (parsedBody.data.decision === "deny") {
      await safeAuditRejection(authorizeAuditSink, {
        orgId: actor.orgId,
        actorId: actor.id,
        clientId: validation.clientId,
        redirectUri: validation.redirectUri,
        reason: "access_denied",
      });
      return reply
        .code(302)
        .header(
          "location",
          redirectWithParams(validation.redirectUri, {
            error: "access_denied",
            error_description: "The user denied the authorization request.",
            ...(validation.state === undefined ? {} : { state: validation.state }),
          }),
        )
        .send();
    }

    try {
      if (authorizationCodeService === undefined) {
        throw new OAuthError("invalid_request", "Authorization Code flow is not enabled.", 400);
      }
      await authorizationStore.recordGrant({
        clientId: validation.clientId,
        actorId: actor.id,
        orgId: actor.orgId,
        scopes: validation.scopes,
      });
      const { code } = await authorizationCodeService.issueCode({
        clientId: validation.clientId,
        actorId: actor.id,
        orgId: actor.orgId,
        redirectUri: validation.redirectUri,
        scopes: validation.scopes,
        codeChallenge: validation.codeChallenge,
        ...(validation.state === undefined ? {} : { state: validation.state }),
      });
      return await reply
        .code(302)
        .header("cache-control", "no-store")
        .header(
          "location",
          redirectWithParams(validation.redirectUri, {
            code,
            ...(validation.state === undefined ? {} : { state: validation.state }),
          }),
        )
        .send();
    } catch (error) {
      if (error instanceof OAuthError) {
        await safeAuditRejection(authorizeAuditSink, {
          orgId: actor.orgId,
          actorId: actor.id,
          clientId: validation.clientId,
          redirectUri: validation.redirectUri,
          reason: "code_issue_failed",
          metadata: { error: error.code },
        });
        return sendOAuthError(reply, error);
      }
      throw error;
    }
  });

  // RFC 7009 — OAuth 2.0 Token Revocation.
  app.post("/oauth/revoke", { bodyLimit: OAUTH_BODY_LIMIT_BYTES }, async (request, reply) => {
    const parsedBody = tokenManagementBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return sendOAuthError(
        reply,
        new OAuthError("invalid_request", "Invalid revocation request body.", 400),
      );
    }

    const clientAuthentication = parseTokenManagementClient(request, parsedBody.data);
    if (clientAuthentication instanceof OAuthError) {
      return sendOAuthError(reply, clientAuthentication);
    }

    try {
      await tokenService.authenticateClient(
        clientAuthentication.clientId,
        clientAuthentication.clientSecret,
      );
    } catch (error) {
      if (error instanceof OAuthError) {
        return sendOAuthError(reply, error);
      }
      throw error;
    }

    // RFC 7009 §2.2: the endpoint responds 200 even for unknown tokens.
    if (parsedBody.data.token !== undefined && parsedBody.data.token.length > 0) {
      await tokenService.revokeToken({
        token: parsedBody.data.token,
        clientId: clientAuthentication.clientId,
        ...(parsedBody.data.token_type_hint === "access_token" ||
        parsedBody.data.token_type_hint === "refresh_token"
          ? { tokenTypeHint: parsedBody.data.token_type_hint }
          : {}),
      });
    }
    return reply.code(200).header("cache-control", "no-store").header("pragma", "no-cache").send();
  });

  // RFC 7662 — OAuth 2.0 Token Introspection.
  app.post("/oauth/introspect", { bodyLimit: OAUTH_BODY_LIMIT_BYTES }, async (request, reply) => {
    const parsedBody = tokenManagementBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return sendOAuthError(
        reply,
        new OAuthError("invalid_request", "Invalid introspection request body.", 400),
      );
    }

    const clientAuthentication = parseTokenManagementClient(request, parsedBody.data);
    if (clientAuthentication instanceof OAuthError) {
      return sendOAuthError(reply, clientAuthentication);
    }

    try {
      await tokenService.authenticateClient(
        clientAuthentication.clientId,
        clientAuthentication.clientSecret,
      );
    } catch (error) {
      if (error instanceof OAuthError) {
        return sendOAuthError(reply, error);
      }
      throw error;
    }

    const introspection =
      parsedBody.data.token === undefined || parsedBody.data.token.length === 0
        ? { active: false }
        : await tokenService.introspectToken({
            token: parsedBody.data.token,
            clientId: clientAuthentication.clientId,
          });
    return reply
      .code(200)
      .header("cache-control", "no-store")
      .header("pragma", "no-cache")
      .send(introspection);
  });
}

async function handleClientCredentialsGrant(
  request: FastifyRequest,
  reply: FastifyReply,
  tokenService: OAuthTokenService,
  body: z.infer<typeof tokenRequestBodySchema>,
): Promise<FastifyReply> {
  const clientAuthentication = parseClientAuthentication(request, body);
  if (clientAuthentication instanceof OAuthError) {
    return sendOAuthError(reply, clientAuthentication);
  }
  try {
    const response = await tokenService.issueClientCredentialsToken({
      grantType: "client_credentials",
      clientId: clientAuthentication.clientId,
      clientSecret: clientAuthentication.clientSecret,
      ...(body.scope === undefined ? {} : { scope: body.scope }),
    });
    return await reply
      .header("cache-control", "no-store")
      .header("pragma", "no-cache")
      .send(response);
  } catch (error) {
    if (error instanceof OAuthError) {
      return sendOAuthError(reply, error);
    }
    throw error;
  }
}

async function handleAuthorizationCodeGrant(
  request: FastifyRequest,
  reply: FastifyReply,
  tokenService: OAuthTokenService,
  body: z.infer<typeof tokenRequestBodySchema>,
): Promise<FastifyReply> {
  if (body.code === undefined || body.code.length === 0) {
    return sendOAuthError(
      reply,
      new OAuthError("invalid_request", "Missing authorization code.", 400),
    );
  }
  if (body.redirect_uri === undefined || body.redirect_uri.length === 0) {
    return sendOAuthError(reply, new OAuthError("invalid_request", "Missing redirect_uri.", 400));
  }
  if (body.code_verifier === undefined || body.code_verifier.length === 0) {
    return sendOAuthError(
      reply,
      new OAuthError("invalid_request", "Missing PKCE code_verifier.", 400),
    );
  }
  // The client_id may be authenticated via Basic auth (confidential client)
  // or supplied in the body (public client). Either form is accepted.
  const basic = parseOAuthBasicAuthorization(request.headers.authorization);
  const clientId = basic?.clientId ?? body.client_id;
  if (clientId === undefined || clientId.length === 0) {
    return sendOAuthError(reply, new OAuthError("invalid_request", "Missing client_id.", 400));
  }
  const clientSecret = basic?.clientSecret ?? body.client_secret;
  try {
    const response = await tokenService.issueAuthorizationCodeToken({
      grantType: "authorization_code",
      clientId,
      ...(clientSecret === undefined ? {} : { clientSecret }),
      code: body.code,
      redirectUri: body.redirect_uri,
      codeVerifier: body.code_verifier,
    });
    return await reply
      .header("cache-control", "no-store")
      .header("pragma", "no-cache")
      .send(response);
  } catch (error) {
    if (error instanceof OAuthError) {
      return sendOAuthError(reply, error);
    }
    throw error;
  }
}

async function handleRefreshTokenGrant(
  request: FastifyRequest,
  reply: FastifyReply,
  tokenService: OAuthTokenService,
  body: z.infer<typeof tokenRequestBodySchema>,
): Promise<FastifyReply> {
  if (body.refresh_token === undefined || body.refresh_token.length === 0) {
    return sendOAuthError(reply, new OAuthError("invalid_request", "Missing refresh_token.", 400));
  }
  const basic = parseOAuthBasicAuthorization(request.headers.authorization);
  const clientId = basic?.clientId ?? body.client_id;
  if (clientId === undefined || clientId.length === 0) {
    return sendOAuthError(reply, new OAuthError("invalid_request", "Missing client_id.", 400));
  }
  const clientSecret = basic?.clientSecret ?? body.client_secret;
  try {
    const response = await tokenService.issueRefreshToken({
      grantType: "refresh_token",
      clientId,
      ...(clientSecret === undefined ? {} : { clientSecret }),
      refreshToken: body.refresh_token,
      ...(body.scope === undefined ? {} : { scope: body.scope }),
    });
    return await reply
      .header("cache-control", "no-store")
      .header("pragma", "no-cache")
      .send(response);
  } catch (error) {
    if (error instanceof OAuthError) {
      return sendOAuthError(reply, error);
    }
    throw error;
  }
}

interface ValidatedAuthorizeParams {
  readonly responseType: "code";
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly scopes: readonly string[];
  readonly state?: string | undefined;
}

const CONSENT_TOKEN_TTL_MS = 5 * 60 * 1000;
const consentPayloadSchema = z
  .object({
    version: z.literal(1),
    actorId: z.string().min(1).max(200),
    orgId: z.string().min(1).max(200),
    nonce: z.string().min(32).max(200),
    expiresAt: z.number().int().positive(),
    validation: z
      .object({
        responseType: z.literal("code"),
        clientId: z.string().min(1).max(500),
        redirectUri: z.string().min(1).max(4096),
        codeChallenge: z.string().min(43).max(128),
        scopes: z.array(z.string().min(1).max(200)).max(100),
        state: z.string().max(2048).optional(),
      })
      .strict(),
  })
  .strict();

type ConsentPayload = z.infer<typeof consentPayloadSchema>;

async function issueConsentToken(
  secret: string,
  store: OAuthAuthorizationStore,
  validation: ValidatedAuthorizeParams,
  actor: Actor,
): Promise<string> {
  const nonce = getCryptoProvider().randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + CONSENT_TOKEN_TTL_MS;
  const payload: ConsentPayload = {
    version: 1,
    actorId: actor.id,
    orgId: actor.orgId,
    nonce,
    expiresAt,
    validation: {
      ...validation,
      scopes: [...validation.scopes],
    },
  };
  await store.saveConsentNonce({
    nonceHash: sha256Hex(nonce),
    clientId: validation.clientId,
    actorId: actor.id,
    orgId: actor.orgId,
    expiresAt: new Date(expiresAt),
  });
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${signConsentToken(secret, encoded)}`;
}

function verifyConsentToken(secret: string, token: string): ConsentPayload | null {
  const segments = token.split(".");
  if (segments.length !== 2) {
    return null;
  }
  const [encoded, signature] = segments;
  if (encoded === undefined || signature === undefined) {
    return null;
  }
  const expected = signConsentToken(secret, encoded);
  if (
    !getCryptoProvider().timingSafeEqual(
      Buffer.from(signature, "utf8"),
      Buffer.from(expected, "utf8"),
    )
  ) {
    return null;
  }
  try {
    const parsed = consentPayloadSchema.safeParse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
    return parsed.success && parsed.data.expiresAt > Date.now() ? parsed.data : null;
  } catch {
    return null;
  }
}

function signConsentToken(secret: string, encodedPayload: string): string {
  return getCryptoProvider().hmac(
    "sha256",
    secret,
    `helix-oauth-consent-v1.${encodedPayload}`,
    "base64url",
  );
}

function validateAuthorizeParams(input: {
  readonly response_type: string;
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly code_challenge: string;
  readonly code_challenge_method?: string | undefined;
  readonly scope?: string | undefined;
  readonly state?: string | undefined;
}): ValidatedAuthorizeParams | OAuthError {
  if (input.response_type !== "code") {
    return new OAuthError("invalid_request", "Only response_type=code is supported.", 400);
  }
  if (!isAbsoluteHttpUri(input.redirect_uri)) {
    return new OAuthError("invalid_request", "redirect_uri must be an absolute http(s) URI.", 400);
  }
  if (!isValidCodeChallenge(input.code_challenge)) {
    return new OAuthError(
      "invalid_request",
      "code_challenge must be 43-128 unreserved characters.",
      400,
    );
  }
  // CRITICAL-3 (REVIEW.md): only S256 is acceptable. Accepting `plain` is a
  // PKCE downgrade and lets an attacker who steals the authorization code
  // immediately redeem it. Default to `S256` when omitted (per OAuth 2.1).
  if (input.code_challenge_method !== undefined && input.code_challenge_method !== "S256") {
    return new OAuthError(
      "invalid_request",
      "code_challenge_method must be S256 (PKCE 'plain' is not allowed).",
      400,
    );
  }
  let scopes: readonly string[] = [];
  if (input.scope !== undefined && input.scope.trim().length > 0) {
    scopes = [...new Set(input.scope.split(" ").filter((token) => token.length > 0))];
  }
  return {
    responseType: "code",
    clientId: input.client_id,
    redirectUri: input.redirect_uri,
    codeChallenge: input.code_challenge,
    scopes,
    ...(input.state === undefined ? {} : { state: input.state }),
  };
}

async function resolveAuthorizeActor(
  request: FastifyRequest,
  reply: FastifyReply,
  options: OAuthRoutesOptions,
  validation: ValidatedAuthorizeParams,
): Promise<Actor | null> {
  if (options.actorResolver === undefined) {
    await safeAuditRejection(options.authorizeAuditSink, {
      orgId: null,
      actorId: null,
      clientId: validation.clientId,
      redirectUri: validation.redirectUri,
      reason: "invalid_request",
      metadata: { error: "authorization_code_disabled" },
    });
    sendOAuthError(
      reply,
      new OAuthError("invalid_request", "Authorization Code flow is not enabled.", 400),
    );
    return null;
  }
  const actor = await options.actorResolver.resolve(request);
  if (actor === null) {
    await safeAuditRejection(options.authorizeAuditSink, {
      orgId: null,
      actorId: null,
      clientId: validation.clientId,
      redirectUri: validation.redirectUri,
      reason: "login_required",
    });
    reply
      .code(401)
      .header("cache-control", "no-store")
      .header("www-authenticate", 'Bearer realm="Helix OAuth"')
      .send({
        error: "login_required",
        error_description: "Sign in to authorize this application.",
      });
    return null;
  }
  return actor;
}

function authorizeParamsToQuery(params: ValidatedAuthorizeParams, consentToken: string): string {
  const query = new URLSearchParams({
    response_type: params.responseType,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    consent_token: consentToken,
  });
  if (params.scopes.length > 0) {
    query.set("scope", params.scopes.join(" "));
  }
  if (params.state !== undefined) {
    query.set("state", params.state);
  }
  return query.toString();
}

function redirectWithParams(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function renderConsentPage(
  params: ValidatedAuthorizeParams,
  actor: Actor,
  consentToken: string,
): string {
  const scopeList =
    params.scopes.length === 0
      ? "<li>Basic access</li>"
      : params.scopes.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join("");
  const hidden = (name: string, value: string): string =>
    `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authorize application — Helix</title>
</head>
<body>
  <main>
    <h1>Authorize access</h1>
    <p>Application <strong>${escapeHtml(params.clientId)}</strong> is requesting access to your Helix account
      (<strong>${escapeHtml(actor.displayName ?? actor.email ?? actor.id)}</strong>).</p>
    <p>It will be able to:</p>
    <ul>${scopeList}</ul>
    <form method="post" action="${HELIX_API_VERSION_PREFIX}/oauth/authorize">
      ${hidden("consent_token", consentToken)}
      <button type="submit" name="decision" value="approve">Allow</button>
      <button type="submit" name="decision" value="deny">Deny</button>
    </form>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

interface AuthorizeRejection {
  readonly statusCode: number;
  readonly title: string;
  readonly detail: string;
  readonly reason: OAuthAuthorizeRejectionReason;
}

/**
 * Validate the supplied `redirect_uri` against the OAuth client's registered
 * allowlist (CRITICAL-3, REVIEW.md). On mismatch the request MUST be refused
 * with a fixed-URL HTML error page — never with a redirect to the attacker-
 * supplied URI. An audit record is emitted for each rejection.
 *
 * Returns `null` on success, or a {@link AuthorizeRejection} payload the
 * caller renders directly to the browser.
 */
async function checkAuthorizeClient(input: {
  readonly clientStore: OAuthClientStore;
  readonly authorizationStore: OAuthAuthorizationStore;
  readonly validation: ValidatedAuthorizeParams;
  readonly auditSink: OAuthAuthorizeAuditSink | undefined;
  readonly actor: Actor;
}): Promise<AuthorizeRejection | null> {
  const { clientStore, authorizationStore, validation, auditSink, actor } = input;
  const client = await clientStore.findClient(validation.clientId);
  if (client === null) {
    await safeAuditRejection(auditSink, {
      orgId: null,
      actorId: actor.id,
      clientId: validation.clientId,
      redirectUri: validation.redirectUri,
      reason: "unknown_client",
    });
    return {
      statusCode: 400,
      title: "Unknown OAuth client",
      detail: "The client_id supplied in this authorization request is not registered.",
      reason: "unknown_client",
    };
  }
  if (client.revokedAt !== null) {
    await safeAuditRejection(auditSink, {
      orgId: client.orgId,
      actorId: actor.id,
      clientId: client.clientId,
      redirectUri: validation.redirectUri,
      reason: "client_revoked",
    });
    return {
      statusCode: 400,
      title: "OAuth client has been revoked",
      detail: "This OAuth client has been revoked and can no longer request new authorizations.",
      reason: "client_revoked",
    };
  }
  if (client.expiresAt !== null && client.expiresAt <= new Date()) {
    await safeAuditRejection(auditSink, {
      orgId: client.orgId,
      actorId: actor.id,
      clientId: client.clientId,
      redirectUri: validation.redirectUri,
      reason: "client_expired",
    });
    return {
      statusCode: 400,
      title: "OAuth client has expired",
      detail: "This OAuth client has expired and can no longer request new authorizations.",
      reason: "client_expired",
    };
  }
  // Every OAuth client is a tenant installation. A future signed global app
  // still needs a distinct per-tenant installation record; there is no global
  // client bypass that can mint a subject in another tenant.
  if (client.orgId !== actor.orgId) {
    await safeAuditRejection(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      clientId: client.clientId,
      redirectUri: validation.redirectUri,
      reason: "tenant_mismatch",
      metadata: { clientOrgId: client.orgId },
    });
    return {
      statusCode: 403,
      title: "OAuth client is not installed for this organization",
      detail: "This OAuth client cannot request access to an account in another organization.",
      reason: "tenant_mismatch",
    };
  }
  if (!(await authorizationStore.isClientApproved(actor.orgId, client.clientId))) {
    await safeAuditRejection(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      clientId: client.clientId,
      redirectUri: validation.redirectUri,
      reason: "installation_not_approved",
    });
    return {
      statusCode: 403,
      title: "OAuth application is not approved",
      detail: "An administrator must approve this OAuth application before users can authorize it.",
      reason: "installation_not_approved",
    };
  }
  if (!matchesRegisteredRedirectUri(client, validation.redirectUri)) {
    await safeAuditRejection(auditSink, {
      orgId: client.orgId,
      actorId: actor.id,
      clientId: client.clientId,
      redirectUri: validation.redirectUri,
      reason: "redirect_uri_mismatch",
      metadata: {
        registeredCount: client.redirectUris.length,
      },
    });
    return {
      statusCode: 400,
      title: "Invalid redirect_uri",
      detail:
        "The redirect_uri supplied in this authorization request does not match any redirect URI registered for this OAuth client. Ask the application owner to register the URI in the Helix admin console.",
      reason: "redirect_uri_mismatch",
    };
  }
  const unauthorizedScope = validation.scopes.find(
    (scope) => !client.scopes.includes(scope) || !actorHasScope(actor, scope),
  );
  if (unauthorizedScope !== undefined) {
    await safeAuditRejection(auditSink, {
      orgId: client.orgId,
      actorId: actor.id,
      clientId: client.clientId,
      redirectUri: validation.redirectUri,
      reason: "invalid_scope",
      metadata: { scope: unauthorizedScope },
    });
    return {
      statusCode: 400,
      title: "Invalid OAuth scope",
      detail: "The application requested access it or the current user is not allowed to grant.",
      reason: "invalid_scope",
    };
  }
  return null;
}

/**
 * Exact-string match check against the client's registered redirect-URI
 * allowlist. No prefix matching, no wildcards, no query/fragment tolerance.
 * An empty allowlist denies authorization by default.
 */
function matchesRegisteredRedirectUri(client: OAuthClientRecord, redirectUri: string): boolean {
  return client.redirectUris.some((registered) => registered === redirectUri);
}

function sendAuthorizeRejection(reply: FastifyReply, rejection: AuthorizeRejection): FastifyReply {
  // CRITICAL-3: render an HTML page served from this origin. We never redirect
  // to the unverified redirect_uri because that is exactly the open-redirect
  // primitive an attacker is trying to obtain.
  return reply
    .code(rejection.statusCode)
    .header("content-type", "text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .header("pragma", "no-cache")
    .send(renderAuthorizeRejectionPage(rejection));
}

function renderAuthorizeRejectionPage(rejection: AuthorizeRejection): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(rejection.title)} — Helix</title>
</head>
<body>
  <main>
    <h1>${escapeHtml(rejection.title)}</h1>
    <p>${escapeHtml(rejection.detail)}</p>
    <p>Helix declined to redirect because the destination is not on the registered allowlist for this application.</p>
  </main>
</body>
</html>`;
}

async function safeAuditRejection(
  sink: OAuthAuthorizeAuditSink | undefined,
  input: Parameters<OAuthAuthorizeAuditSink["recordRejection"]>[0],
): Promise<void> {
  if (sink === undefined) {
    return;
  }
  try {
    await sink.recordRejection(input);
  } catch {
    // Audit-log writes are best-effort. The security decision has already
    // been made; do not let a logging failure surface to the attacker.
  }
}

async function auditAuthorizeValidationFailure(
  sink: OAuthAuthorizeAuditSink | undefined,
  input: {
    readonly client_id: string;
    readonly redirect_uri: string;
    readonly code_challenge_method?: string | undefined;
  },
  error: OAuthError,
): Promise<void> {
  const pkceDowngrade = error.message.includes("S256");
  await safeAuditRejection(sink, {
    orgId: null,
    actorId: null,
    clientId: input.client_id,
    redirectUri: input.redirect_uri,
    reason: pkceDowngrade ? "pkce_plain" : "invalid_request",
    metadata: {
      error: error.code,
      ...(input.code_challenge_method === undefined ? {} : { method: input.code_challenge_method }),
    },
  });
}

async function auditMalformedAuthorizeRequest(
  sink: OAuthAuthorizeAuditSink | undefined,
  value: unknown,
): Promise<void> {
  const input =
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  await safeAuditRejection(sink, {
    orgId: null,
    actorId: null,
    clientId: boundedAuditField(input["client_id"], "<missing>"),
    redirectUri: boundedAuditField(input["redirect_uri"], "<missing>"),
    reason: "invalid_request",
  });
}

function boundedAuditField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 512) : fallback;
}

function normalizeIssuer(value: string): string {
  let issuer: URL;
  try {
    issuer = new URL(value);
  } catch {
    throw new Error("OAuth issuer must be an absolute URL.");
  }
  const local =
    issuer.hostname === "localhost" ||
    issuer.hostname === "127.0.0.1" ||
    issuer.hostname === "[::1]";
  if (
    (issuer.protocol !== "https:" && !(local && issuer.protocol === "http:")) ||
    issuer.username.length > 0 ||
    issuer.password.length > 0 ||
    issuer.search.length > 0 ||
    issuer.hash.length > 0 ||
    (issuer.pathname !== "/" && issuer.pathname !== "")
  ) {
    throw new Error("OAuth issuer must be an HTTPS origin (HTTP is allowed only for localhost).");
  }
  return issuer.origin;
}

function isAbsoluteHttpUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function registerUrlEncodedParser(app: FastifyInstance): void {
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      if (typeof body !== "string") {
        done(new Error("Expected urlencoded body to be parsed as a string"), undefined);
        return;
      }
      done(null, Object.fromEntries(new URLSearchParams(body)));
    },
  );
}

function parseClientAuthentication(
  request: FastifyRequest,
  body: { readonly client_id?: string | undefined; readonly client_secret?: string | undefined },
): { readonly clientId: string; readonly clientSecret: string } | OAuthError {
  const basic = parseOAuthBasicAuthorization(request.headers.authorization);
  const bodyCredentials =
    body.client_id === undefined || body.client_secret === undefined
      ? null
      : { clientId: body.client_id, clientSecret: body.client_secret };

  if (basic !== null && bodyCredentials !== null) {
    return new OAuthError(
      "invalid_request",
      "Use exactly one OAuth client authentication method.",
      400,
    );
  }

  const credentials = basic ?? bodyCredentials;
  if (
    credentials === null ||
    credentials.clientId.length === 0 ||
    credentials.clientSecret.length === 0
  ) {
    return new OAuthError("invalid_client", "OAuth client credentials are required.", 401);
  }
  return credentials;
}

function parseTokenManagementClient(
  request: FastifyRequest,
  body: { readonly client_id?: string | undefined; readonly client_secret?: string | undefined },
): { readonly clientId: string; readonly clientSecret?: string } | OAuthError {
  const basic = parseOAuthBasicAuthorization(request.headers.authorization);
  if (basic !== null && (body.client_id !== undefined || body.client_secret !== undefined)) {
    return new OAuthError(
      "invalid_request",
      "Use exactly one OAuth client authentication method.",
      400,
    );
  }
  const clientId = basic?.clientId ?? body.client_id;
  const clientSecret = basic?.clientSecret ?? body.client_secret;
  if (clientId === undefined || clientId.length === 0) {
    return new OAuthError("invalid_client", "OAuth client_id is required.", 401);
  }
  return {
    clientId,
    ...(clientSecret === undefined || clientSecret.length === 0 ? {} : { clientSecret }),
  };
}

function parseOAuthBasicAuthorization(
  authorization: string | undefined,
): { readonly clientId: string; readonly clientSecret: string } | null {
  const basic = parseBasicAuthorization(authorization);
  return basic === null ? null : { clientId: basic.username, clientSecret: basic.password };
}

function sendOAuthError(reply: FastifyReply, error: OAuthError): FastifyReply {
  if (error.code === "invalid_client") {
    reply.header("www-authenticate", 'Basic realm="Helix OAuth"');
  }
  return reply
    .code(error.statusCode)
    .header("cache-control", "no-store")
    .header("pragma", "no-cache")
    .send({
      error: error.code,
      error_description: error.message,
    });
}
