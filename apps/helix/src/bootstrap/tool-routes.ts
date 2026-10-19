import { finishTenantRequestTransaction } from "../platform/tenancy/middleware.js";
import { pendingActionQueueSchema } from "@helix/contracts";
import { pendingActionLinks } from "../api/pending-action-links.js";
import { redactToolInvokeResult } from "../platform/tools/sensitive-output.js";
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { type SessionActorResolver } from "../api/actor.js";
import { buildErrorEnvelope, toolErrorEnvelope } from "../api/error-envelope.js";
import {
  DEFAULT_IDEMPOTENCY_TTL_MS,
  authorizeIdempotentReplay,
  idempotencyPrincipalFingerprint,
  isPersistableIdempotentResult,
  fingerprintRequestPayload,
  idempotencyStorageKey,
  type IdempotencyStore,
} from "../api/idempotency.js";
import type { PlatformMetrics } from "../api/metrics.js";
import { createRequestContext } from "../api/trace.js";
import { HELIX_API_VERSION_HEADER_VALUE } from "../api/version.js";
import { type AgentCredentialStore } from "../platform/auth/credentials.js";
import { requestHasCrownJewelApproval } from "../platform/auth/crown-jewel.js";
import type { AccessTokenStore } from "../platform/auth/oauth.js";
import {
  toolInvocationOptions,
  type ToolInvocationPrincipal,
} from "../platform/auth/tool-invocation-principal.js";
import {
  type RuntimeToolRegistry,
  type ToolInvokeErrorResult,
  type ToolInvokeOptions,
  type ToolInvokeResult,
} from "../platform/tool-registry.js";
import { resolveRequestPrincipal, traceIdForRequest } from "./request-principal.js";

const toolParamsSchema = z.object({
  toolId: z.string().min(1),
});

const pendingActionParamsSchema = z.object({
  pendingId: z.string().uuid(),
});

export interface ToolRestRoutesOptions {
  readonly publicBaseUrl?: string;
  readonly tools: RuntimeToolRegistry;
  readonly metrics: PlatformMetrics;
  readonly tokenStore: AccessTokenStore;
  readonly sessionResolver?: SessionActorResolver;
  /**
   * Store backing API-key / mTLS credential authentication and per-credential
   * policy enforcement (PRD §9.2). When omitted, credential auth is disabled.
   */
  readonly credentialStore?: AgentCredentialStore;
  /**
   * Store backing `Idempotency-Key` replay for mutating tool calls (P1-10).
   * When omitted, idempotency handling is disabled.
   */
  readonly idempotencyStore?: IdempotencyStore;
  /** TTL for stored idempotency records, in milliseconds. */
  readonly idempotencyTtlMs?: number;
}

/**
 * How long an in-flight idempotency claim blocks duplicates. Bounded so a
 * crashed replica cannot pin a key for the whole replay window.
 */
const IDEMPOTENCY_CLAIM_TTL_MS = 10 * 60 * 1000;
const IDEMPOTENCY_IN_PROGRESS_RETRY_AFTER_SECONDS = 2;
function toolResultStatusCode(result: ToolInvokeResult): number {
  if (!result.ok) return result.statusCode;
  return result.status === "pending_confirmation" ? 202 : 200;
}

function sendToolInvokeResult(
  reply: FastifyReply,
  result: ToolInvokeResult,
  traceId: string,
  publicBaseUrl?: string,
) {
  if (!result.ok) {
    return sendToolInvokeError(reply, result, traceId);
  }
  if (result.status === "pending_confirmation") {
    return reply.code(202).send({
      status: result.status,
      pending: { ...result.pending, ...pendingActionLinks(result.pending.id, publicBaseUrl) },
    });
  }
  return reply.code(200).send(result.output);
}

/** Extracts the `Idempotency-Key` header value if present. */
function idempotencyKeyFromRequest(request: FastifyRequest): string | undefined {
  const header = request.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export interface ActionStatusRoutesOptions {
  readonly tools: RuntimeToolRegistry;
  readonly tokenStore: AccessTokenStore;
  readonly sessionResolver?: SessionActorResolver;
  /** Store backing API-key / mTLS credential authentication (PRD §9.2). */
  readonly credentialStore?: AgentCredentialStore;
}

export type PendingActionMutationRoutesOptions = ActionStatusRoutesOptions;

export type ToolRestRouteMethod = "GET" | "POST";

export function registerToolRestRoutes(
  app: FastifyInstance,
  options: ToolRestRoutesOptions,
  methods: readonly ToolRestRouteMethod[] = ["POST", "GET"],
): void {
  if (methods.includes("POST")) {
    app.post("/api/tools/:toolId", async (request, reply) => {
      const params = toolParamsSchema.parse(request.params);
      const traceId = traceIdForRequest(request);
      const tool = options.tools.get(params.toolId);
      const principal = await resolveRequestPrincipal(
        request,
        options.tokenStore,
        options.sessionResolver,
        options.credentialStore,
      );
      // P1-10: Idempotency-Key replay for mutating (non-read) tool calls. Read
      // tools are naturally idempotent so the key is ignored for them.
      const idempotencyKey = idempotencyKeyFromRequest(request);
      const idempotencyStore = options.idempotencyStore;
      const idempotency:
        | {
            readonly store: IdempotencyStore;
            readonly key: string;
            readonly hash: string;
          }
        | undefined =
        idempotencyStore !== undefined &&
        idempotencyKey !== undefined &&
        tool !== undefined &&
        tool.sideEffects !== "read"
          ? await (async () => {
              return {
                store: idempotencyStore,
                key: idempotencyStorageKey({
                  orgId: principal.actor.orgId,
                  actorId: principal.actor.id,
                  toolId: params.toolId,
                  idempotencyKey,
                }),
                hash: fingerprintRequestPayload(request.body),
              };
            })()
          : undefined;
      if (idempotency === undefined) {
        const result = await invokeTool(
          options.tools,
          principal,
          params.toolId,
          request.body,
          request,
        );
        return sendToolInvokeResult(reply, result, traceId, options.publicBaseUrl);
      }
      // CA3: claim the key atomically before invoking so concurrent retries
      // cannot both execute the mutation.
      const claim = await idempotency.store.claim(
        idempotency.key,
        idempotency.hash,
        IDEMPOTENCY_CLAIM_TTL_MS,
      );
      if (claim.kind === "conflict") {
        reply.header("api-version", HELIX_API_VERSION_HEADER_VALUE);
        return reply.code(409).send(
          buildErrorEnvelope({
            statusCode: 409,
            code: "idempotency_key_reused",
            message: "Idempotency-Key was already used with a different request payload.",
            traceId,
          }),
        );
      }
      if (claim.kind === "in_progress") {
        reply.header("api-version", HELIX_API_VERSION_HEADER_VALUE);
        reply.header("retry-after", String(IDEMPOTENCY_IN_PROGRESS_RETRY_AFTER_SECONDS));
        return reply.code(409).send(
          buildErrorEnvelope({
            statusCode: 409,
            code: "idempotency_in_progress",
            message:
              "A request with this Idempotency-Key is still running. Retry after it completes to receive its result.",
            traceId,
            details: { retryAfterSeconds: IDEMPOTENCY_IN_PROGRESS_RETRY_AFTER_SECONDS },
          }),
        );
      }
      if (claim.kind === "replay") {
        reply.header("idempotency-replayed", "true");
        return sendToolInvokeResult(
          reply,
          await authorizeIdempotentReplay(
            options.tools,
            principal,
            params.toolId,
            request.body,
            claim.record,
          ),
          traceId,
          options.publicBaseUrl,
        );
      }
      let result: ToolInvokeResult;
      try {
        result = await invokeTool(options.tools, principal, params.toolId, request.body, request);
      } catch (error) {
        await idempotency.store.release(idempotency.key, claim.claimToken);
        throw error;
      }
      await finishTenantRequestTransaction(request, result.ok || result.statusCode < 500);
      if (!isPersistableIdempotentResult(result)) {
        // Auth, timeout, rate-limit, and server failures describe the moment,
        // not the request: free the key so a retry runs instead of replaying.
        await idempotency.store.release(idempotency.key, claim.claimToken);
        return sendToolInvokeResult(reply, result, traceId, options.publicBaseUrl);
      }
      try {
        await idempotency.store.complete(idempotency.key, claim.claimToken, {
          result: redactToolInvokeResult(tool, result),
          principalFingerprint: idempotencyPrincipalFingerprint(principal),
          statusCode: toolResultStatusCode(result),
          requestHash: idempotency.hash,
          expiresAt: Date.now() + (options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS),
        });
      } catch (error) {
        // The mutation already ran; report its result rather than inviting a
        // retry that could execute it twice.
        request.log.warn({ err: error }, "Failed to persist idempotent tool result");
      }
      return sendToolInvokeResult(reply, result, traceId, options.publicBaseUrl);
    });
  }
  if (methods.includes("GET")) {
    app.get("/api/tools/:toolId", async (request, reply) => {
      const params = toolParamsSchema.parse(request.params);
      const traceId = traceIdForRequest(request);
      const tool = options.tools.get(params.toolId);
      if (tool === undefined) {
        return reply.code(404).send(
          buildErrorEnvelope({
            statusCode: 404,
            code: "tool_not_found",
            message: `Unknown tool: ${params.toolId}`,
            traceId,
          }),
        );
      }
      if (tool.sideEffects !== "read") {
        return reply.code(405).send(
          buildErrorEnvelope({
            statusCode: 405,
            code: "method_not_allowed",
            message: `Tool is not safe for GET: ${params.toolId}`,
            traceId,
          }),
        );
      }
      const result = await invokeTool(
        options.tools,
        await resolveRequestPrincipal(
          request,
          options.tokenStore,
          options.sessionResolver,
          options.credentialStore,
        ),
        params.toolId,
        request.query,
        request,
      );
      if (!result.ok) {
        return sendToolInvokeError(reply, result, traceId);
      }
      if (result.status === "pending_confirmation")
        return sendToolInvokeResult(reply, result, traceId, options.publicBaseUrl);
      return result.output;
    });
  }
}

export function registerActionStatusRoutes(
  app: FastifyInstance,
  options: ActionStatusRoutesOptions,
): void {
  app.get("/actions", async (request, reply) => {
    const principal = await resolveRequestPrincipal(
      request,
      options.tokenStore,
      options.sessionResolver,
      options.credentialStore,
    );
    if (principal.actor.type !== "user")
      return reply.code(403).send({ error: "Action review requires a signed-in person." });
    const query = z
      .object({
        offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
        limit: z.coerce.number().int().min(1).max(50).default(50),
      })
      .parse(request.query);
    return pendingActionQueueSchema.parse(
      await options.tools.listPendingActions({ actor: principal.actor, ...query }),
    );
  });
  const actionStatusHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = pendingActionParamsSchema.parse(request.params);
    const principal = await resolveRequestPrincipal(
      request,
      options.tokenStore,
      options.sessionResolver,
      options.credentialStore,
    );
    const result = await options.tools.getPendingAction(params.pendingId, {
      actor: principal.actor,
    });
    if (!result.ok) {
      return sendToolInvokeError(reply, result, traceIdForRequest(request));
    }
    return { action: result.pending };
  };
  app.get("/actions/:pendingId", actionStatusHandler);
  app.get("/actions/:pendingId/review", async (request, reply) => {
    const params = pendingActionParamsSchema.parse(request.params);
    const principal = await resolveRequestPrincipal(
      request,
      options.tokenStore,
      options.sessionResolver,
      options.credentialStore,
    );
    const result = await options.tools.getPendingAction(params.pendingId, {
      actor: principal.actor,
      includeMailReview: true,
    });
    if (!result.ok) return sendToolInvokeError(reply, result, traceIdForRequest(request));
    return { action: result.pending, review: result.review };
  });
}

/** Register authenticated approval/cancellation routes with fresh credential policy resolution. */
export function registerPendingActionMutationRoutes(
  app: FastifyInstance,
  options: PendingActionMutationRoutesOptions,
): void {
  app.post("/api/tools/pending/:pendingId/approve", async (request, reply) => {
    const params = pendingActionParamsSchema.parse(request.params);
    const principal = await resolveRequestPrincipal(
      request,
      options.tokenStore,
      options.sessionResolver,
      options.credentialStore,
    );
    const result = await options.tools.approvePending(params.pendingId, {
      ...toolInvocationOptions(principal, createRequestContext(request)),
    });
    if (!result.ok) {
      return sendToolInvokeError(reply, result, traceIdForRequest(request));
    }
    if (result.status === "pending_confirmation") {
      return reply.code(202).send({ status: result.status, pending: result.pending });
    }
    return { status: "executed", output: result.output };
  });
  app.post("/api/tools/pending/:pendingId/cancel", async (request, reply) => {
    const params = pendingActionParamsSchema.parse(request.params);
    const principal = await resolveRequestPrincipal(
      request,
      options.tokenStore,
      options.sessionResolver,
      options.credentialStore,
    );
    const result = await options.tools.cancelPending(params.pendingId, {
      ...toolInvocationOptions(principal, createRequestContext(request)),
    });
    if (!result.ok) {
      return sendToolInvokeError(reply, result, traceIdForRequest(request));
    }
    return { status: result.status, pending: result.pending };
  });
}

export async function invokeTool(
  tools: RuntimeToolRegistry,
  principal: ToolInvocationPrincipal,
  toolId: string,
  input: unknown,
  request: FastifyRequest,
  executeHandler?: ToolInvokeOptions["executeHandler"],
) {
  const result = await tools.invoke(toolId, input, {
    ...toolInvocationOptions(principal, createRequestContext(request)),
    enforceConfirmation: true,
    ...(executeHandler === undefined ? {} : { executeHandler }),
    ...(requestHasCrownJewelApproval(request) ? { skipConfirmation: true } : {}),
  });
  return result;
}

export function sendToolInvokeError(
  reply: FastifyReply,
  result: ToolInvokeErrorResult,
  traceId: string,
) {
  if (result.retryAfterSeconds !== undefined) {
    reply.header("retry-after", String(result.retryAfterSeconds));
  }
  // P1-10: single canonical error envelope with a traceId across every surface.
  return reply.code(result.statusCode).send(toolErrorEnvelope(result, traceId));
}
