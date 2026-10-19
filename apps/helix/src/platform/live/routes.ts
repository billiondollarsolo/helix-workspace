import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  liveEventQuerySchema,
  presenceHeartbeatSchema,
  presenceStatusInputSchema,
} from "@helix/contracts";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import {
  ForbiddenError,
  RateLimitedError,
  BadRequestError,
  UnauthorizedError,
} from "../../api/api-error.js";
import { requireActorScope } from "../../api/scopes.js";
import type { ToolInvocationPrincipal } from "../auth/tool-invocation-principal.js";
import { EventStreamLimiter } from "../events/stream-limit.js";
import { MCP_SUBSCRIPTION_ID, mcpSubscriptionParamsSchema } from "../../api/mcp-modern.js";
import { parseJsonRpcRequest } from "../../api/mcp-jsonrpc.js";
import { LiveStore } from "./store.js";

export const EVENT_INBOX_URI = "helix://events/inbox";
export class LiveRoutes {
  readonly store: LiveStore;
  private readonly hints = new EventEmitter();
  private readonly limiter = new EventStreamLimiter();
  private readonly streams = new Set<() => void>();
  constructor(
    private readonly sql: postgres.Sql,
    private readonly resolvePrincipal: (
      request: FastifyRequest,
    ) => Promise<ToolInvocationPrincipal>,
  ) {
    this.store = new LiveStore(sql);
    this.hints.setMaxListeners(0);
  }
  private async resolve(request: FastifyRequest) {
    const principal = await this.resolvePrincipal(request);
    if (principal.actor.id === "anonymous") throw new UnauthorizedError("Authentication required.");
    return principal;
  }
  async install(app: FastifyInstance) {
    const listener = await this.sql.listen("helix_actor_events", (payload) => {
      try {
        const hint = z
          .object({ orgId: z.string().uuid(), actorId: z.string().uuid() })
          .parse(JSON.parse(payload));
        this.hints.emit(`${hint.orgId}:${hint.actorId}`);
      } catch {
        /* Invalid hints never become events. */
      }
    });
    const configuration = await this.sql.listen("helix_workspace_config", () => {
      this.hints.emit("configuration");
    });
    app.addHook("preClose", async () => {
      for (const close of this.streams) close();
    });
    app.addHook("onClose", async () => {
      await listener.unlisten();
      await configuration.unlisten();
    });
    app.get("/api/events", async (request) => {
      const { actor } = await this.resolve(request);
      requireActorScope(actor, "notifications.read");
      const query = liveEventQuerySchema.parse(request.query);
      return this.store.list(actor, query.after, query.limit);
    });
    app.get("/api/events/stream", (request, reply) => this.stream(request, reply, false));
    app.get("/api/presence", async (request) => {
      const { actor } = await this.resolve(request);
      const { actors } = z.object({ actors: z.string().max(4000).optional() }).parse(request.query);
      const ids = z
        .array(z.string().uuid())
        .min(1)
        .max(100)
        .parse(actors?.split(",") ?? [actor.id]);
      if (ids.some((id) => id !== actor.id)) requireActorScope(actor, "chat.read");
      return { items: await this.store.status(actor, ids) };
    });
    app.patch("/api/presence", async (request) => {
      const principal = await this.resolve(request);
      if (principal.credentialId !== undefined || principal.actor.type !== "user")
        throw new ForbiddenError(
          "Agents must use presence.set so credential scopes and approval policy apply.",
        );
      return {
        presence: await this.store.setStatus(
          principal.actor,
          presenceStatusInputSchema.parse(request.body),
        ),
      };
    });
    app.post("/api/presence/heartbeat", async (request) => {
      const { actor } = await this.resolve(request);
      const input = presenceHeartbeatSchema.parse(request.body);
      await this.store.heartbeat(actor, input.connectionId, input.state, input.disconnect);
      return { ok: true };
    });
  }
  async read(actor: Actor, uri: string) {
    const url = new URL(uri);
    if (
      url.origin !== "null" ||
      url.protocol !== "helix:" ||
      url.hostname !== "events" ||
      url.pathname !== "/inbox" ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new BadRequestError("Unknown event resource.");
    requireActorScope(actor, "notifications.read");
    const parsed = liveEventQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success)
      throw new BadRequestError(
        "Event resource requires a nonnegative integer after cursor and a limit from 1 to 100.",
      );
    const query = parsed.data;
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(await this.store.list(actor, query.after, query.limit)),
    };
  }
  private binding(principal: ToolInvocationPrincipal) {
    return principal.credentialId ?? `actor:${principal.actor.id}`;
  }
  async stream(request: FastifyRequest, reply: FastifyReply, mcp: boolean) {
    const principal = await this.resolve(request),
      actor = principal.actor;
    requireActorScope(actor, "notifications.read");
    const subscription = mcp ? parseJsonRpcRequest(request.body) : undefined;
    const filter = mcp
      ? mcpSubscriptionParamsSchema.parse(subscription?.params).notifications
      : undefined;
    const subscribed = filter?.resourceSubscriptions?.includes(EVENT_INBOX_URI) ?? false;
    const subscriptionMeta = { [MCP_SUBSCRIPTION_ID]: subscription?.id };
    const query = liveEventQuerySchema.parse(
      mcp
        ? {}
        : {
            ...(request.query as object),
            ...(request.headers["last-event-id"] === undefined
              ? {}
              : { after: request.headers["last-event-id"] }),
          },
    );
    // MCP updates are hints, not transport replay; the resource read owns durable cursors.
    const tail =
      !mcp &&
      z.object({ tail: z.literal("1").optional() }).parse(request.query).tail === "1" &&
      request.headers["last-event-id"] === undefined;
    const initial = mcp || tail ? await this.store.list(actor, Number.MAX_SAFE_INTEGER) : undefined;
    const release = this.limiter.acquire(actor.orgId);
    if (release === null) throw new RateLimitedError("Too many event streams.");
    const connectionId = randomUUID(),
      key = `${actor.orgId}:${actor.id}`;
    try {
      await this.store.heartbeat(actor, connectionId, "idle");
    } catch (error) {
      release();
      throw error;
    }
    let cursor = initial?.latestCursor ?? query.after,
      closed = false,
      running = false,
      again = false,
      lastBeat = Date.now();
    const close = (graceful = false) => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      clearTimeout(lifetime);
      this.hints.off(key, wake);
      this.hints.off("configuration", refresh);
      this.streams.delete(shutdown);
      release();
      if (graceful && mcp && !reply.raw.destroyed)
        reply.raw.write(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: subscription?.id, result: { _meta: subscriptionMeta } })}\n\n`,
        );
      reply.raw.end();
      void this.store.heartbeat(actor, connectionId, "idle", true).catch(() => undefined);
    };
    const write = (data: unknown, event = "events", id?: number) => {
      if (closed) return;
      if (
        !reply.raw.write(
          `${id === undefined ? "" : `id: ${String(id)}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
        )
      )
        close();
    };
    const authorize = async () => {
      const current = await this.resolve(request);
      if (
        current.actor.id !== actor.id ||
        current.actor.orgId !== actor.orgId ||
        this.binding(current) !== this.binding(principal)
      )
        throw new ForbiddenError("Event identity changed.");
      requireActorScope(current.actor, "notifications.read");
      return current.actor;
    };
    const pump = async () => {
      if (closed) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        const current = await authorize();
        if (Date.now() - lastBeat >= 15000) {
          await this.store.heartbeat(current, connectionId, "idle");
          lastBeat = Date.now();
          if (!reply.raw.write(": heartbeat\n\n")) {
            close();
            return;
          }
        }
        if (mcp && !subscribed) return;
        const page = await this.store.list(current, cursor);
        await authorize();
        if (page.resetRequired) {
          write(
            mcp
              ? {
                  jsonrpc: "2.0",
                  method: "notifications/resources/updated",
                  params: {
                    uri: EVENT_INBOX_URI,
                    _meta: { ...subscriptionMeta, "si.helixapps/resetRequired": true },
                  },
                }
              : page,
            mcp ? "message" : "reset",
          );
          close();
          return;
        }
        if (page.cursor !== cursor) {
          write(
            mcp
              ? {
                  jsonrpc: "2.0",
                  method: "notifications/resources/updated",
                  params: { uri: EVENT_INBOX_URI, _meta: subscriptionMeta },
                }
              : page,
            mcp ? "message" : "events",
            mcp ? undefined : page.cursor,
          );
          cursor = page.cursor;
        }
        again = again || page.hasMore;
      } catch {
        close();
      } finally {
        running = false;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Socket callbacks can close the stream during awaited queries.
        if (again && !closed) {
          again = false;
          queueMicrotask(wake);
        }
      }
    };
    const wake = () => {
      void pump();
    };
    const refresh = () => {
      void authorize()
        .then(() => {
          if (!mcp) write({}, "refresh");
        })
        .catch(() => {
          close();
        });
    };
    const shutdown = () => {
      close(true);
    };
    const timer = setInterval(wake, 5000),
      lifetime = setTimeout(shutdown, 55 * 60000);
    this.streams.add(shutdown);
    this.hints.on(key, wake);
    this.hints.on("configuration", refresh);
    reply.raw.on("close", () => {
      close();
    });
    reply.raw.on("error", () => {
      close();
    });
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    if (mcp) {
      write(
        {
          jsonrpc: "2.0",
          method: "notifications/subscriptions/acknowledged",
          params: {
            notifications: subscribed ? { resourceSubscriptions: [EVENT_INBOX_URI] } : {},
            _meta: subscriptionMeta,
          },
        },
        "message",
      );
      if (!subscribed) {
        shutdown();
        return;
      }
    } else reply.raw.write(": connected\n\n");
    wake();
  }
}
