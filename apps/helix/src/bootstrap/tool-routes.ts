import { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { type SessionActorResolver } from "../api/actor.js";
import { buildErrorEnvelope, toolErrorEnvelope } from "../api/error-envelope.js";
import {
  DEFAULT_IDEMPOTENCY_TTL_MS,
  fingerprintRequestPayload,
  idempotencyStorageKey,
  resolveIdempotency,
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
} from "../platform/tool-registry.js";
import { resolveRequestPrincipal, traceIdForRequest } from "./request-principal.js";

const toolParamsSchema = z.object({
  toolId: z.string().min(1),
});

const pendingActionParamsSchema = z.object({
  pendingId: z.string().uuid(),
});

export interface ToolRestRoutesOptions {
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
      if (idempotency !== undefined) {
        const outcome = await resolveIdempotency(
          idempotency.store,
          idempotency.key,
          idempotency.hash,
        );
        if (outcome.kind === "conflict") {
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
        if (outcome.kind === "replay") {
          reply.header("idempotency-replayed", "true");
          const replayed = outcome.record.result;
          if (!replayed.ok) {
            return sendToolInvokeError(reply, replayed, traceId);
          }
          if (replayed.status === "pending_confirmation") {
            return reply.code(202).send({ status: replayed.status, pending: replayed.pending });
          }
          return reply.code(outcome.record.statusCode).send(replayed.output);
        }
      }
      const result = await invokeTool(
        options.tools,
        principal,
        params.toolId,
        request.body,
        request,
      );
      if (idempotency !== undefined) {
        const statusCode = result.ok
          ? result.status === "pending_confirmation"
            ? 202
            : 200
          : result.statusCode;
        // Only persist deterministic outcomes — transient 5xx failures should
        // be retryable rather than pinned to a stored error.
        if (result.ok || result.statusCode < 500) {
          await idempotency.store.set(idempotency.key, {
            result,
            statusCode,
            requestHash: idempotency.hash,
            expiresAt: Date.now() + (options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS),
          });
        }
      }
      if (!result.ok) {
        return sendToolInvokeError(reply, result, traceId);
      }
      if (result.status === "pending_confirmation") {
        return reply.code(202).send({ status: result.status, pending: result.pending });
      }
      return result.output;
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
      if (result.status === "pending_confirmation") {
        return reply.code(202).send({ status: result.status, pending: result.pending });
      }
      return result.output;
    });
  }
}

export function registerActionStatusRoutes(
  app: FastifyInstance,
  options: ActionStatusRoutesOptions,
): void {
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
