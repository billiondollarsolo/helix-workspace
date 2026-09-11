import { type FastifyInstance } from "fastify";
import { type SessionActorResolver } from "../api/actor.js";
import { buildErrorEnvelope } from "../api/error-envelope.js";
import { createRequestContext } from "../api/trace.js";
import { HELIX_API_VERSION_HEADER_VALUE } from "../api/version.js";
import {
  assistantChatBodySchema,
  type AssistantSendMessageInput,
  type AssistantStreamEvent,
} from "../platform/assistant/index.js";
import { toJsonObject } from "../platform/util/json.js";
import { type AgentCredentialStore } from "../platform/auth/credentials.js";
import type { AccessTokenStore } from "../platform/auth/oauth.js";
import { type RuntimeToolRegistry } from "../platform/tool-registry.js";
import { finishTenantRequestTransaction } from "../platform/tenancy/index.js";
import { resolveRequestPrincipal, traceIdForRequest } from "./request-principal.js";
import { acceptsEventStream } from "./route-scope.js";
import { invokeTool, sendToolInvokeError } from "./tool-routes.js";

/** Minimal orchestrator surface needed by the assistant SSE route. */
export interface AssistantStreamOrchestrator {
  sendMessageStream(input: AssistantSendMessageInput): AsyncGenerator<AssistantStreamEvent>;
}

export interface AssistantStreamRouteOptions {
  readonly orchestrator: AssistantStreamOrchestrator;
  /** Tool registry used to serve non-streaming `assistant.chat` requests. */
  readonly tools: RuntimeToolRegistry;
  readonly tokenStore: AccessTokenStore;
  readonly sessionResolver?: SessionActorResolver;
  readonly credentialStore?: AgentCredentialStore;
  readonly onError?: (error: unknown) => void;
}

/**
 * Registers the assistant SSE streaming endpoint (PRD §9.5).
 *
 * `POST /api/tools/assistant.chat` runs {@link AssistantOrchestrator.sendMessageStream}
 * and, when the client negotiates `text/event-stream`, emits each incremental
 * `delta` event followed by a terminal `final` event carrying the full turn.
 * This static route is registered before the parametric `/api/tools/:toolId`
 * route, so it takes precedence for the assistant chat tool while every other
 * tool keeps the standard JSON REST behaviour. When the client does NOT accept
 * an event stream the request is served through the standard JSON
 * tool-invocation path so non-streaming callers are unaffected.
 */
export function registerAssistantStreamRoute(
  app: FastifyInstance,
  options: AssistantStreamRouteOptions,
): void {
  app.post("/api/tools/assistant.chat", async (request, reply) => {
    if (!acceptsEventStream(request)) {
      // Non-streaming callers use the standard JSON tool-invocation path.
      const traceId = traceIdForRequest(request);
      const result = await invokeTool(
        options.tools,
        await resolveRequestPrincipal(
          request,
          options.tokenStore,
          options.sessionResolver,
          options.credentialStore,
        ),
        "assistant.chat",
        request.body,
        request,
      );
      if (!result.ok) {
        return sendToolInvokeError(reply, result, traceId);
      }
      if (result.status === "pending_confirmation") {
        return reply.code(202).send({ status: result.status, pending: result.pending });
      }
      return result.output;
    }
    // Validate the streaming request body BEFORE the SSE headers are written.
    // On invalid input every other tool route returns the canonical HelixError
    // envelope (`{error:{code,message,traceId}}`); align this route to it
    // instead of leaking Fastify's raw `{statusCode,error,message}` 500.
    const parsedBody = assistantChatBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      const traceId = traceIdForRequest(request);
      return reply.code(400).send(
        buildErrorEnvelope({
          statusCode: 400,
          code: "bad_request",
          message: `Invalid assistant.chat request body: ${parsedBody.error.message}`,
          traceId,
        }),
      );
    }
    const body = parsedBody.data;
    const principal = await resolveRequestPrincipal(
      request,
      options.tokenStore,
      options.sessionResolver,
      options.credentialStore,
    );
    const abort = new AbortController();
    const startStream = () => {
      if (reply.raw.headersSent) return;
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "api-version": HELIX_API_VERSION_HEADER_VALUE,
      });
    };
    const onClose = () => {
      if (!reply.raw.writableFinished) abort.abort();
    };
    reply.raw.on("close", onClose);
    try {
      const result = await invokeTool(
        options.tools,
        principal,
        "assistant.chat",
        body,
        request,
        async () => {
          if (principal.actor.type === "user") startStream();
          const stream = options.orchestrator.sendMessageStream({
            actor: principal.actor,
            principal,
            content: body.message,
            ...(body.webSearch === undefined ? {} : { webSearch: body.webSearch }),
            ...(body.toolGroups === undefined ? {} : { toolGroups: body.toolGroups }),
            request: createRequestContext(request),
            signal: abort.signal,
            metadata: toJsonObject(body.metadata),
            ...(body.conversationId === undefined ? {} : { conversationId: body.conversationId }),
            ...(body.editMessageId === undefined ? {} : { editMessageId: body.editMessageId }),
            ...(body.title === undefined ? {} : { title: body.title }),
            ...(body.memoryOptIn === undefined ? {} : { memoryOptIn: body.memoryOptIn }),
            ...(body.modelId === undefined ? {} : { modelId: body.modelId }),
            ...(body.attachmentObjectIds === undefined
              ? {}
              : { attachmentObjectIds: body.attachmentObjectIds }),
          });
          let final: Extract<AssistantStreamEvent, { type: "final" }> | undefined;
          try {
            for await (const event of stream) {
              abort.signal.throwIfAborted();
              if (event.type === "final") final = event;
              // Agent outputs require the registry's output DLP check before disclosure.
              else if (principal.actor.type === "user")
                reply.raw.write(formatAssistantSseEvent(event));
            }
          } catch (error) {
            if (!abort.signal.aborted) options.onError?.(error);
            throw error;
          }
          abort.signal.throwIfAborted();
          if (final === undefined) throw new Error("The assistant stream ended without a result.");
          return final.turn;
        },
      );
      if (!result.ok) {
        await finishTenantRequestTransaction(request, false);
        if (!reply.raw.headersSent)
          return await sendToolInvokeError(reply, result, traceIdForRequest(request));
        if (!abort.signal.aborted)
          reply.raw.write(formatAssistantSseEvent({ type: "error", message: result.error }));
      } else if (result.status === "pending_confirmation") {
        return await reply.code(202).send({ status: result.status, pending: result.pending });
      } else {
        abort.signal.throwIfAborted();
        await finishTenantRequestTransaction(request, true);
        startStream();
        reply.raw.write(
          formatAssistantSseEvent({
            type: "final",
            turn: result.output as Extract<AssistantStreamEvent, { type: "final" }>["turn"],
          }),
        );
      }
    } catch (error) {
      await finishTenantRequestTransaction(request, false);
      options.onError?.(error);
      if (!reply.raw.headersSent) throw error;
      if (!abort.signal.aborted)
        reply.raw.write(
          formatAssistantSseEvent({
            type: "error",
            message: "The assistant stream failed.",
          }),
        );
    } finally {
      reply.raw.off("close", onClose);
      if (reply.raw.headersSent && !reply.raw.writableEnded) reply.raw.end();
    }
    return reply;
  });
}

/** An assistant SSE frame: a stream event or a terminal error notice. */
export type AssistantSseFrame =
  | AssistantStreamEvent
  | {
      readonly type: "error";
      readonly message: string;
    };

/** Serializes an assistant SSE frame to the `text/event-stream` wire format. */
export function formatAssistantSseEvent(event: AssistantSseFrame): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
