import type { Actor, EventBus } from "@helix/sdk-types";
import { TLSSocket } from "node:tls";
import { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  toolInvocationPrincipalFromRequest,
  unauthenticatedActor,
  untrustedIdentityHeader,
  type SessionActorResolver,
} from "../api/actor.js";
import { buildErrorEnvelope } from "../api/error-envelope.js";
import { createRequestContext } from "../api/trace.js";
import { internalApiUrl } from "../api/version.js";
import { type AgentCredentialStore } from "../platform/auth/credentials.js";
import type { AccessTokenStore } from "../platform/auth/oauth.js";
import { type ToolInvocationPrincipal } from "../platform/auth/tool-invocation-principal.js";
import { type TenantApiRpsLimiter } from "../platform/limits/index.js";
import {
  assertActorMatchesRequestTenant,
  setTenantPostgresActorId,
} from "../platform/tenancy/index.js";

/**
 * Raised when an API-key / mTLS credential is presented on the request path
 * but fails authentication or per-credential policy enforcement (PRD §9.2).
 * The server error handler maps this to the carried HTTP status.
 */
export class CredentialAuthError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CredentialAuthError";
  }
}

/**
 * Resolve the request actor, enforcing API-key / mTLS credential policy first
 * (PRD §9.2) and falling back to bearer access tokens and sessions. Shared by
 * the tool REST routes so credential enforcement is live on every surface.
 */
export async function resolveRequestPrincipal(
  request: FastifyRequest,
  tokenStore: AccessTokenStore,
  sessionResolver: SessionActorResolver | undefined,
  credentialStore: AgentCredentialStore | undefined,
): Promise<ToolInvocationPrincipal> {
  const resolution = await toolInvocationPrincipalFromRequest(
    request,
    tokenStore,
    sessionResolver,
    credentialStore,
  );
  if (!resolution.ok) {
    throw new CredentialAuthError(resolution.statusCode, resolution.code, resolution.message);
  }
  assertActorMatchesRequestTenant(request, resolution.principal.actor);
  if (resolution.principal.actor.id !== unauthenticatedActor.id)
    await setTenantPostgresActorId(resolution.principal.actor.id);
  return resolution.principal;
}

/** Derives a trace identifier for error envelopes and idempotency scoping. */
export function traceIdForRequest(request: FastifyRequest): string {
  const context = createRequestContext(request);
  return context.traceId ?? context.requestId;
}

export interface TenantApiRpsLimitHookOptions {
  readonly limiter: TenantApiRpsLimiter;
  readonly sessionResolver?: SessionActorResolver | undefined;
  readonly events?: Pick<EventBus, "publish"> | undefined;
  readonly onQuotaEventError?: ((error: unknown) => void) | undefined;
}

/** Share cryptographic verification and session policy checks only within one HTTP request. */
export function cacheSessionActorResolver(resolver: SessionActorResolver): SessionActorResolver {
  const requests = new WeakMap<FastifyRequest, Promise<Actor | null>>();
  return {
    resolve(request) {
      let actor = requests.get(request);
      if (actor === undefined) {
        actor = resolver.resolve(request);
        requests.set(request, actor);
      }
      return actor;
    },
  };
}

const BROWSER_REQUEST_LIMIT = 120;
const BROWSER_REQUEST_WINDOW_MS = 10_000;

async function verifiedBrowserActor(
  request: FastifyRequest,
  resolver: SessionActorResolver | undefined,
) {
  // Credentials retain their API quota even when the caller also sends a session cookie.
  if (
    !request.headers.cookie ||
    request.headers.authorization !== undefined ||
    request.headers["x-api-key"] !== undefined ||
    (request.raw.socket instanceof TLSSocket && request.raw.socket.authorized)
  )
    return null;
  const actor = await resolver?.resolve(request);
  if (actor?.type !== "user") return null;
  assertActorMatchesRequestTenant(request, actor);
  return actor;
}

export function installUntrustedIdentityHeaderGuard(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    const header = untrustedIdentityHeader(request.headers);
    if (header !== undefined) {
      return reply.code(401).send(
        buildErrorEnvelope({
          statusCode: 401,
          code: "untrusted_identity_assertion",
          message: "Client-supplied identity assertions are not accepted.",
          traceId: traceIdForRequest(request),
          details: { header },
        }),
      );
    }
  });
}

/* Paths that hold a connection open rather than answering and closing.
 *
 * Only `/events/ws` for now, deliberately. `/sse/mail` and `/ws/chat` have the
 * same shape and the same argument applies to them, but they are metered today
 * and nothing has been observed to suffer for it — exempting a surface means
 * moving it onto the concurrency cap instead, and that is a change worth making
 * per surface, with its own verification, rather than in a sweep. */
const LONG_LIVED_STREAM_PATHS: ReadonlySet<string> = new Set(["/events/ws"]);

function isLongLivedStreamPath(path: string): boolean {
  return LONG_LIVED_STREAM_PATHS.has(path);
}

export function installTenantApiRpsLimitHook(
  app: FastifyInstance,
  options: TenantApiRpsLimitHookOptions,
): void {
  app.addHook("preHandler", async (request, reply) => {
    const path = internalApiUrl(request.url).split("?")[0] ?? request.url;
    if (path === "/api/auth" || path.startsWith("/api/auth/")) {
      return;
    }
    /* Long-lived streams are exempt from the *rate* meter.
     *
     * `api_rps_limit` bounds work per unit time, and that is the wrong shape
     * for a connection that costs one upgrade and then lives for minutes. The
     * cost was real and visible: the admin console opens its event sockets as a
     * section mounts, so the upgrades landed in the same one-second window as
     * that section's own queries and pushed the page over its own budget — a
     * liveness feature stealing the request budget from the data it exists to
     * keep fresh.
     *
     * These connections are still bounded, just by the right control: a
     * per-org cap on *concurrent* streams, enforced at upgrade time by
     * `assertStreamConnectionAvailable` below. */
    if (isLongLivedStreamPath(path)) {
      return;
    }
    const tenant = request.tenant;
    if (tenant === null) {
      return;
    }
    const effectiveConfig = tenant.effectiveConfig;
    const browser = await verifiedBrowserActor(request, options.sessionResolver);
    const admin =
      path === "/api/admin" ||
      path.startsWith("/api/admin/") ||
      path === "/trpc/admin" ||
      path.startsWith("/trpc/admin.");
    const quota = browser === null ? "api_rps_limit" : "browser_requests";
    const headerPrefix = browser === null ? "x-helix-quota-api-rps" : "x-helix-browser-rate-limit";
    const code = browser === null ? "quota.api_rps.exceeded" : "rate_limit.browser.exceeded";
    const windowMs = browser === null ? 1_000 : BROWSER_REQUEST_WINDOW_MS;
    const decision = await options.limiter.consume({
      orgId: tenant.orgId,
      limit: browser === null ? effectiveConfig.quotas.api_rps_limit : BROWSER_REQUEST_LIMIT,
      ...(browser === null
        ? {}
        : { bucket: `browser:${browser.id}:${admin ? "admin" : "app"}`, windowMs }),
    });
    reply.header(
      "x-helix-rate-limit-policy",
      browser === null ? "integration-api" : admin ? "browser-admin" : "browser",
    );
    reply.header("x-helix-rate-limit-window-ms", String(windowMs));
    if (decision.allowed) {
      reply.header(
        `${headerPrefix}-limit`,
        decision.limit === null ? "unlimited" : String(decision.limit),
      );
      reply.header(
        `${headerPrefix}-remaining`,
        decision.remaining === null ? "unlimited" : String(decision.remaining),
      );
      if (decision.resetsAt !== null) {
        reply.header(`${headerPrefix}-reset`, decision.resetsAt);
      }
      return;
    }
    reply.header("retry-after", String(decision.retryAfterSeconds));
    reply.header(`${headerPrefix}-limit`, String(decision.limit));
    reply.header(`${headerPrefix}-remaining`, "0");
    reply.header(`${headerPrefix}-reset`, decision.resetsAt);
    void options.events
      ?.publish(code, {
        orgId: tenant.orgId,
        quota,
        surface: "http.request",
        limit: decision.limit,
        used: decision.used,
        remaining: decision.remaining,
        retryAfterSeconds: decision.retryAfterSeconds,
        resetsAt: decision.resetsAt,
        windowMs,
        method: request.method,
        path,
      })
      .catch((error: unknown) => {
        options.onQuotaEventError?.(error);
      });
    return reply.code(429).send(
      buildErrorEnvelope({
        statusCode: 429,
        code,
        message:
          browser === null
            ? "Tenant API request rate limit exceeded."
            : "Browser request rate limit exceeded. Wait briefly and try again.",
        traceId: traceIdForRequest(request),
        details: {
          quota,
          windowMs,
          limit: decision.limit,
          used: decision.used,
          remaining: decision.remaining,
          retryAfterSeconds: decision.retryAfterSeconds,
          resetsAt: decision.resetsAt,
        },
      }),
    );
  });
}
