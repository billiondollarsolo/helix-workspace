import type { EventBus } from "@helix/sdk-types";
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
  readonly events?: Pick<EventBus, "publish"> | undefined;
  readonly onQuotaEventError?: ((error: unknown) => void) | undefined;
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
    const decision = await options.limiter.consume({
      orgId: tenant.orgId,
      limit: effectiveConfig.quotas.api_rps_limit,
    });
    if (decision.allowed) {
      reply.header(
        "x-helix-quota-api-rps-limit",
        decision.limit === null ? "unlimited" : String(decision.limit),
      );
      reply.header(
        "x-helix-quota-api-rps-remaining",
        decision.remaining === null ? "unlimited" : String(decision.remaining),
      );
      if (decision.resetsAt !== null) {
        reply.header("x-helix-quota-api-rps-reset", decision.resetsAt);
      }
      return;
    }
    reply.header("retry-after", String(decision.retryAfterSeconds));
    reply.header("x-helix-quota-api-rps-limit", String(decision.limit));
    reply.header("x-helix-quota-api-rps-remaining", "0");
    reply.header("x-helix-quota-api-rps-reset", decision.resetsAt);
    void options.events
      ?.publish("quota.api_rps.exceeded", {
        orgId: tenant.orgId,
        quota: "api_rps_limit",
        surface: "http.request",
        limit: decision.limit,
        used: decision.used,
        remaining: decision.remaining,
        retryAfterSeconds: decision.retryAfterSeconds,
        resetsAt: decision.resetsAt,
        method: request.method,
        path,
      })
      .catch((error: unknown) => {
        options.onQuotaEventError?.(error);
      });
    return reply.code(429).send(
      buildErrorEnvelope({
        statusCode: 429,
        code: "quota.api_rps.exceeded",
        message: "Tenant API request rate limit exceeded.",
        traceId: traceIdForRequest(request),
        details: {
          quota: "api_rps_limit",
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
