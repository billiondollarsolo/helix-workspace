import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Actor, JsonObject } from "@helix/sdk-types";
import { z } from "zod3";
import {
  InMemoryOAuthClientStore,
  OAuthError,
  OAuthTokenService,
  type OAuthClientRecord,
  type OAuthClientStore,
} from "./oauth.js";
import {
  AuthorizationCodeService,
  InMemoryAuthorizationCodeStore,
  isValidCodeChallenge,
  type CodeChallengeMethod,
} from "./authorization-code.js";

const tokenRequestBodySchema = z.object({
  grant_type: z.string(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  scope: z.string().optional(),
  code: z.string().optional(),
  redirect_uri: z.string().optional(),
  code_verifier: z.string().optional(),
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

const authorizeDecisionBodySchema = z.object({
  response_type: z.string(),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  code_challenge: z.string().min(1),
  code_challenge_method: z.string().optional(),
  scope: z.string().optional(),
  state: z.string().optional(),
  decision: z.enum(["approve", "deny"]),
});

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
export interface OAuthAuthorizeAuditSink {
  recordRejection(input: {
    readonly orgId: string | null;
    readonly actorId: string | null;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly reason:
      | "redirect_uri_mismatch"
      | "pkce_plain"
      | "unknown_client"
      | "client_revoked";
    readonly metadata?: JsonObject;
  }): Promise<void>;
}

export interface OAuthRoutesOptions {
  readonly tokenService?: OAuthTokenService;
  /**
   * Authorization-code service (PRD §13.6). When provided alongside
   * {@link actorResolver}, `/oauth/authorize` and the `authorization_code`
   * token grant are enabled.
   */
  readonly authorizationCodeService?: AuthorizationCodeService;
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
  readonly clientStore?: OAuthClientStore;
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
  options: OAuthRoutesOptions = {},
): Promise<void> {
  registerUrlEncodedParser(app);

  const defaultStore = new InMemoryOAuthClientStore();
  const authorizationCodeService =
    options.authorizationCodeService ??
    new AuthorizationCodeService({ codeStore: new InMemoryAuthorizationCodeStore() });
  const tokenService =
    options.tokenService ??
    new OAuthTokenService({
      clientStore: defaultStore,
      tokenStore: defaultStore,
      authorizationCodeService,
    });
  // CRITICAL-3: the authorize endpoint must resolve the client to look up its
  // registered redirect-URI allowlist. Callers using the built-in defaults get
  // the same in-memory store; production callers wire {@link OAuthRoutesOptions.clientStore}
  // to the Postgres store.
  const clientStore: OAuthClientStore = options.clientStore ?? defaultStore;
  const authorizeAuditSink = options.authorizeAuditSink;

  app.post("/oauth/token", async (request, reply) => {
    const parsedBody = tokenRequestBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return sendOAuthError(reply, new OAuthError("invalid_request", "Invalid token request body.", 400));
    }

    const grantType = parsedBody.data.grant_type;
    if (grantType === "client_credentials") {
      return handleClientCredentialsGrant(request, reply, tokenService, parsedBody.data);
    }
    if (grantType === "authorization_code") {
      return handleAuthorizationCodeGrant(request, reply, tokenService, parsedBody.data);
    }
    return sendOAuthError(
      reply,
      new OAuthError(
        "unsupported_grant_type",
        "Only client_credentials and authorization_code are supported.",
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
      return sendOAuthError(reply, new OAuthError("invalid_request", "Invalid authorization request.", 400));
    }
    const validation = validateAuthorizeParams(parsedQuery.data);
    if (validation instanceof OAuthError) {
      // CRITICAL-3: capture PKCE downgrade attempts before we even resolve
      // the actor. `client_id` and `redirect_uri` came from the query and
      // have not been validated as belonging to a real client, but they are
      // still useful forensic context.
      if (validation.message.includes("S256")) {
        await safeAuditRejection(authorizeAuditSink, {
          orgId: null,
          actorId: null,
          clientId: parsedQuery.data.client_id,
          redirectUri: parsedQuery.data.redirect_uri,
          reason: "pkce_plain",
          metadata: { method: parsedQuery.data.code_challenge_method ?? null },
        });
      }
      return sendOAuthError(reply, validation);
    }

    const clientGuard = await checkAuthorizeClient({
      clientStore,
      validation,
      auditSink: authorizeAuditSink,
      actorId: null,
    });
    if (clientGuard !== null) {
      return sendAuthorizeRejection(reply, clientGuard);
    }

    const actor = await resolveAuthorizeActor(request, reply, options);
    if (actor === null) {
      return reply;
    }

    if (options.consentPagePath !== undefined) {
      const target = `${options.consentPagePath}?${authorizeParamsToQuery(validation)}`;
      return reply.code(302).header("location", target).send();
    }

    return reply
      .code(200)
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .send(renderConsentPage(validation, actor));
  });

  app.post("/oauth/authorize", async (request, reply) => {
    const parsedBody = authorizeDecisionBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return sendOAuthError(reply, new OAuthError("invalid_request", "Invalid authorization decision.", 400));
    }
    const validation = validateAuthorizeParams(parsedBody.data);
    if (validation instanceof OAuthError) {
      if (validation.message.includes("S256")) {
        await safeAuditRejection(authorizeAuditSink, {
          orgId: null,
          actorId: null,
          clientId: parsedBody.data.client_id,
          redirectUri: parsedBody.data.redirect_uri,
          reason: "pkce_plain",
          metadata: { method: parsedBody.data.code_challenge_method ?? null },
        });
      }
      return sendOAuthError(reply, validation);
    }

    const actor = await resolveAuthorizeActor(request, reply, options);
    if (actor === null) {
      return reply;
    }

    const clientGuard = await checkAuthorizeClient({
      clientStore,
      validation,
      auditSink: authorizeAuditSink,
      actorId: actor.id,
    });
    if (clientGuard !== null) {
      return sendAuthorizeRejection(reply, clientGuard);
    }

    if (parsedBody.data.decision === "deny") {
      return reply
        .code(302)
        .header("location", redirectWithParams(validation.redirectUri, {
          error: "access_denied",
          error_description: "The user denied the authorization request.",
          ...(validation.state === undefined ? {} : { state: validation.state }),
        }))
        .send();
    }

    try {
      const { code } = await authorizationCodeService.issueCode({
        clientId: validation.clientId,
        actorId: actor.id,
        orgId: actor.orgId,
        redirectUri: validation.redirectUri,
        scopes: validation.scopes,
        codeChallenge: validation.codeChallenge,
        codeChallengeMethod: validation.codeChallengeMethod,
        ...(validation.state === undefined ? {} : { state: validation.state }),
      });
      return await reply
        .code(302)
        .header("cache-control", "no-store")
        .header("location", redirectWithParams(validation.redirectUri, {
          code,
          ...(validation.state === undefined ? {} : { state: validation.state }),
        }))
        .send();
    } catch (error) {
      if (error instanceof OAuthError) {
        return sendOAuthError(reply, error);
      }
      throw error;
    }
  });

  // RFC 7009 — OAuth 2.0 Token Revocation.
  app.post("/oauth/revoke", async (request, reply) => {
    const parsedBody = tokenManagementBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return sendOAuthError(reply, new OAuthError("invalid_request", "Invalid revocation request body.", 400));
    }

    const clientAuthentication = parseClientAuthentication(request, parsedBody.data);
    if (clientAuthentication instanceof OAuthError) {
      return sendOAuthError(reply, clientAuthentication);
    }

    try {
      await tokenService.authenticateClient(clientAuthentication.clientId, clientAuthentication.clientSecret);
    } catch (error) {
      if (error instanceof OAuthError) {
        return sendOAuthError(reply, error);
      }
      throw error;
    }

    // RFC 7009 §2.2: the endpoint responds 200 even for unknown tokens.
    if (parsedBody.data.token !== undefined && parsedBody.data.token.length > 0) {
      await tokenService.revokeToken(parsedBody.data.token);
    }
    return reply.code(200).header("cache-control", "no-store").header("pragma", "no-cache").send();
  });

  // RFC 7662 — OAuth 2.0 Token Introspection.
  app.post("/oauth/introspect", async (request, reply) => {
    const parsedBody = tokenManagementBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return sendOAuthError(reply, new OAuthError("invalid_request", "Invalid introspection request body.", 400));
    }

    const clientAuthentication = parseClientAuthentication(request, parsedBody.data);
    if (clientAuthentication instanceof OAuthError) {
      return sendOAuthError(reply, clientAuthentication);
    }

    try {
      await tokenService.authenticateClient(clientAuthentication.clientId, clientAuthentication.clientSecret);
    } catch (error) {
      if (error instanceof OAuthError) {
        return sendOAuthError(reply, error);
      }
      throw error;
    }

    const introspection =
      parsedBody.data.token === undefined || parsedBody.data.token.length === 0
        ? { active: false }
        : await tokenService.introspectToken(parsedBody.data.token);
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
    return sendOAuthError(reply, new OAuthError("invalid_request", "Missing authorization code.", 400));
  }
  if (body.redirect_uri === undefined || body.redirect_uri.length === 0) {
    return sendOAuthError(reply, new OAuthError("invalid_request", "Missing redirect_uri.", 400));
  }
  if (body.code_verifier === undefined || body.code_verifier.length === 0) {
    return sendOAuthError(reply, new OAuthError("invalid_request", "Missing PKCE code_verifier.", 400));
  }
  // The client_id may be authenticated via Basic auth (confidential client)
  // or supplied in the body (public client). Either form is accepted.
  const basic = parseBasicAuthorization(request.headers.authorization);
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

interface ValidatedAuthorizeParams {
  readonly responseType: "code";
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: CodeChallengeMethod;
  readonly scopes: readonly string[];
  readonly state?: string;
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
    return new OAuthError("invalid_request", "code_challenge must be 43-128 unreserved characters.", 400);
  }
  // CRITICAL-3 (REVIEW.md): only S256 is acceptable. Accepting `plain` is a
  // PKCE downgrade and lets an attacker who steals the authorization code
  // immediately redeem it. Default to `S256` when omitted (per OAuth 2.1).
  const method = input.code_challenge_method ?? "S256";
  if (method !== "S256") {
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
    codeChallengeMethod: method,
    scopes,
    ...(input.state === undefined ? {} : { state: input.state }),
  };
}

async function resolveAuthorizeActor(
  request: FastifyRequest,
  reply: FastifyReply,
  options: OAuthRoutesOptions,
): Promise<Actor | null> {
  if (options.actorResolver === undefined) {
    sendOAuthError(
      reply,
      new OAuthError("invalid_request", "Authorization Code flow is not enabled.", 400),
    );
    return null;
  }
  const actor = await options.actorResolver.resolve(request);
  if (actor === null) {
    reply
      .code(401)
      .header("cache-control", "no-store")
      .header("www-authenticate", 'Bearer realm="Helix OAuth"')
      .send({ error: "login_required", error_description: "Sign in to authorize this application." });
    return null;
  }
  return actor;
}

function authorizeParamsToQuery(params: ValidatedAuthorizeParams): string {
  const query = new URLSearchParams({
    response_type: params.responseType,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: params.codeChallengeMethod,
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

function renderConsentPage(params: ValidatedAuthorizeParams, actor: Actor): string {
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
    <form method="post" action="/oauth/authorize">
      ${hidden("response_type", params.responseType)}
      ${hidden("client_id", params.clientId)}
      ${hidden("redirect_uri", params.redirectUri)}
      ${hidden("code_challenge", params.codeChallenge)}
      ${hidden("code_challenge_method", params.codeChallengeMethod)}
      ${params.scopes.length > 0 ? hidden("scope", params.scopes.join(" ")) : ""}
      ${params.state === undefined ? "" : hidden("state", params.state)}
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
  readonly reason: "redirect_uri_mismatch" | "unknown_client" | "client_revoked";
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
  readonly validation: ValidatedAuthorizeParams;
  readonly auditSink: OAuthAuthorizeAuditSink | undefined;
  readonly actorId: string | null;
}): Promise<AuthorizeRejection | null> {
  const { clientStore, validation, auditSink, actorId } = input;
  const client = await clientStore.findClient(validation.clientId);
  if (client === null) {
    await safeAuditRejection(auditSink, {
      orgId: null,
      actorId,
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
      actorId,
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
  if (!matchesRegisteredRedirectUri(client, validation.redirectUri)) {
    await safeAuditRejection(auditSink, {
      orgId: client.orgId,
      actorId,
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
  return null;
}

/**
 * Exact-string match check against the client's registered redirect-URI
 * allowlist. No prefix matching, no wildcards, no query/fragment tolerance.
 * An empty allowlist denies authorization by default.
 */
function matchesRegisteredRedirectUri(
  client: OAuthClientRecord,
  redirectUri: string,
): boolean {
  return client.redirectUris.some((registered) => registered === redirectUri);
}

function sendAuthorizeRejection(
  reply: FastifyReply,
  rejection: AuthorizeRejection,
): FastifyReply {
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

function isAbsoluteHttpUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function registerUrlEncodedParser(app: FastifyInstance): void {
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    if (typeof body !== "string") {
      done(new Error("Expected urlencoded body to be parsed as a string"), undefined);
      return;
    }
    done(null, Object.fromEntries(new URLSearchParams(body)));
  });
}

function parseClientAuthentication(
  request: FastifyRequest,
  body: { readonly client_id?: string | undefined; readonly client_secret?: string | undefined },
): { readonly clientId: string; readonly clientSecret: string } | OAuthError {
  const basic = parseBasicAuthorization(request.headers.authorization);
  const bodyCredentials =
    body.client_id === undefined || body.client_secret === undefined
      ? null
      : { clientId: body.client_id, clientSecret: body.client_secret };

  if (basic !== null && bodyCredentials !== null) {
    return new OAuthError("invalid_request", "Use exactly one OAuth client authentication method.", 400);
  }

  const credentials = basic ?? bodyCredentials;
  if (credentials === null || credentials.clientId.length === 0 || credentials.clientSecret.length === 0) {
    return new OAuthError("invalid_client", "OAuth client credentials are required.", 401);
  }
  return credentials;
}

function parseBasicAuthorization(
  authorization: string | undefined,
): { readonly clientId: string; readonly clientSecret: string } | null {
  if (authorization === undefined) {
    return null;
  }
  const [scheme, value] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "basic" || value === undefined) {
    return null;
  }

  const decoded = Buffer.from(value, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return null;
  }
  return {
    clientId: decoded.slice(0, separator),
    clientSecret: decoded.slice(separator + 1),
  };
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
