import websocket from "@fastify/websocket";
import { SYSTEM_TENANT_CONFIG, type Actor } from "@helix/sdk-types";
import fastify, { type FastifyRequest } from "fastify";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerCanonicalApi } from "../../bootstrap/route-scope.js";
import { registerAssistantStreamRoute } from "../../bootstrap/assistant-routes.js";
import {
  AssistantOrchestrator,
  PostgresAssistantStore,
  registerAssistantTools,
} from "../assistant/index.js";
import { InMemoryOAuthClientStore } from "../auth/oauth.js";
import { createToolRegistry } from "../tool-registry.js";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { InMemoryChatPresenceStore, InMemoryChatRoomBus } from "../chat/realtime.js";
import { registerChatRoutes } from "../chat/routes.js";
import { PostgresChatStore } from "../chat/index.js";
import { PostgresChatWebSocketTicketStore } from "../chat/websocket-tickets.js";
import { InMemoryEventBus } from "../events/in-memory-event-bus.js";
import { registerEventRoutes } from "../events/routes.js";
import { registerMailStreamRoutes } from "../mail/stream.js";
import type { TenantContext } from "./context.js";
import {
  installTenantContextHook,
  installTenantPostgresContextHook,
  isLongLivedTenantRequest,
} from "./middleware.js";
import {
  setTenantPostgresActorId,
  tenantAwarePostgresSql,
  withTenantPostgresContext,
} from "./postgres-roles.js";

const orgId = "dc120000-0000-4000-8000-000000000001";
const foreignOrgId = "dc120000-0000-4000-8000-000000000002";
const roomId = "dc120000-0000-4000-8000-000000000021";
const actor: Actor = {
  id: "dc120000-0000-4000-8000-000000000011",
  orgId,
  type: "user",
  displayName: "Stream member",
  scopes: ["chat.read", "assistant.read", "assistant.write"],
};
const tenant: TenantContext = {
  orgId,
  orgSlug: "stream-transactions",
  orgTier: "personal",
  orgRegion: "default",
  effectiveConfig: SYSTEM_TENANT_CONFIG,
  org: {
    id: orgId,
    slug: "stream-transactions",
    displayName: "Stream transactions",
    status: "active",
    tier: "personal",
    planId: "personal",
    region: "default",
    byoConfig: {},
    featureFlags: {},
    quotas: {},
    branding: {},
    suspendedAt: null,
    softDeletedAt: null,
    hardDeletedAt: null,
  },
};
const appName = "helix-stream-transaction-regression";
const lockId = 773388;
const databaseUrl = process.env.DATABASE_URL;
const runtimeUrl = process.env.HELIX_RLS_APP_DATABASE_URL;

describe(
  "long-lived transport PostgreSQL scopes",
  { skip: databaseUrl === undefined || runtimeUrl === undefined },
  () => {
    const app = fastify();
    const events = new InMemoryEventBus();
    let admin: postgres.Sql;
    let sql: postgres.Sql;
    let baseUrl: string;
    let resolvedActors = 0;
    let generationCancelled = false;

    async function resolveActor(request: FastifyRequest): Promise<Actor> {
      const resolve = async () => {
        await setTenantPostgresActorId(actor.id);
        await sql`select pg_advisory_xact_lock(${lockId})`;
        return actor;
      };
      const result = isLongLivedTenantRequest(request)
        ? await withTenantPostgresContext(sql, { orgId }, resolve)
        : await resolve();
      resolvedActors += 1;
      return result;
    }

    beforeAll(async () => {
      if (databaseUrl === undefined || runtimeUrl === undefined)
        throw new Error("Live DB URLs required");
      admin = postgres(databaseUrl, { max: 2, prepare: false, connection: { lock_timeout: 1000 } });
      sql = tenantAwarePostgresSql(
        postgres(runtimeUrl, {
          max: 2,
          prepare: false,
          connection: { application_name: appName, statement_timeout: 2000 },
        }),
      );
      await cleanupTestTenants(admin, [orgId, foreignOrgId]);
      await admin`insert into orgs (id, slug, display_name) values
      (${orgId}, 'stream-transactions', 'Streams'), (${foreignOrgId}, 'stream-transactions-foreign', 'Foreign')`;
      await admin`insert into actors (id, org_id, type, display_name, scopes) values
      (${actor.id}, ${orgId}, 'user', ${actor.displayName ?? ""}, ${admin.array(["chat.read"], 1009)}),
      ('dc120000-0000-4000-8000-000000000012', ${foreignOrgId}, 'user', 'Hidden', '{}')`;
      await admin`insert into threads (id, org_id, kind, subject, created_by_actor_id)
      values (${roomId}, ${orgId}, 'chat_room', 'Streams', ${actor.id})`;
      await admin`insert into chat_room_settings (thread_id, org_id, name) values (${roomId}, ${orgId}, 'Streams')`;
      await admin`insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
      values (${orgId}, ${actor.id}, 'thread', ${roomId}, 'owner', ${actor.id})`;
      await app.register(websocket);
      installTenantContextHook(app, { resolveTenantContext: async () => tenant });
      installTenantPostgresContextHook(app, sql);
      await registerCanonicalApi(app, async (api) => {
        await registerChatRoutes(api, {
          store: new PostgresChatStore(sql),
          tickets: new PostgresChatWebSocketTicketStore(sql),
          actorFromRequest: resolveActor,
          trustedOrigins: [],
          bus: new InMemoryChatRoomBus(),
          presence: new InMemoryChatPresenceStore(),
        });
        await registerEventRoutes(api, { bus: events, actorFromRequest: resolveActor });
        registerMailStreamRoutes(api, { events, resolveActor });
        const tools = createToolRegistry();
        const store = new PostgresAssistantStore(sql);
        const orchestrator = new AssistantOrchestrator({
          store,
          tools,
          ai: {
            async chat() {
              throw new Error("Expected streaming provider");
            },
            async *chatStream(input) {
              yield { delta: "Saved reply" };
              if (input.messages.some((message) => message.content === "cancel-stream")) {
                await new Promise<void>((resolve) =>
                  input.signal?.addEventListener(
                    "abort",
                    () => {
                      generationCancelled = true;
                      resolve();
                    },
                    { once: true },
                  ),
                );
                input.signal?.throwIfAborted();
              }
              if (input.messages.some((message) => message.content === "fail-stream"))
                throw new Error("provider failed");
              yield { delta: "", done: true };
            },
          },
        });
        registerAssistantTools(tools, { store, orchestrator });
        registerAssistantStreamRoute(api, {
          orchestrator,
          tools,
          tokenStore: new InMemoryOAuthClientStore(),
          sessionResolver: { resolve: resolveActor },
        });
        api.get("/api/probe", async (request) => {
          await resolveActor(request);
          return sql<{ id: string }[]>`select id from actors order by id`;
        });
        api.post("/api/fail-write", async (request) => {
          await resolveActor(request);
          await sql`update actors set display_name = 'must roll back' where id = ${actor.id}`;
          throw new Error("audit unavailable");
        });
      });
      baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    });

    afterAll(async () => {
      for (const socket of app.websocketServer?.clients ?? []) socket.terminate();
      await app.close();
      await sql.end({ timeout: 1 });
      await cleanupTestTenants(admin, [orgId, foreignOrgId]);
      await admin.end();
    });

    async function assertReleased(): Promise<void> {
      const response = await fetch(`${baseUrl}/v1/api/probe`, {
        signal: AbortSignal.timeout(3000),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([{ id: actor.id }]);
      const sessions = await admin`select state from pg_stat_activity
      where datname = current_database() and application_name = ${appName}
      and state = 'idle in transaction'`;
      expect(sessions).toHaveLength(0);
    }

    it("retains HTTP rollback even when a client supplies WebSocket upgrade headers", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/api/fail-write",
        headers: { connection: "upgrade", upgrade: "websocket" },
      });
      expect(response.statusCode).toBe(500);
      const rows = await admin`select display_name from actors where id = ${actor.id}`;
      expect(rows[0]?.display_name).toBe(actor.displayName);
      await assertReleased();
    });

    it("persists a streamed Assistant turn before final and rolls back failed turns", async () => {
      const send = (message: string) =>
        fetch(`${baseUrl}/v1/api/tools/assistant.chat`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify({ message }),
        });
      const response = await send("save-stream");
      expect(response.status).toBe(200);
      const frames = await response.text();
      expect(frames).toContain("event: delta");
      expect(frames).toContain("event: final");
      const saved =
        await admin`select role, content from assistant_messages where org_id = ${orgId} order by created_at`;
      expect(saved).toEqual([
        { role: "user", content: "save-stream" },
        { role: "assistant", content: "Saved reply" },
      ]);
      const failed = await (await send("fail-stream")).text();
      expect(failed).toContain("event: error");
      expect(failed).not.toContain("event: final");
      const afterFailure =
        await admin`select role, content from assistant_messages where org_id = ${orgId} order by created_at`;
      expect(afterFailure).toEqual(saved);
      await assertReleased();
    });

    it("cancels upstream generation and rolls back when the streaming client disconnects", async () => {
      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/v1/api/tools/assistant.chat`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ message: "cancel-stream" }),
      });
      if (response.body === null) throw new Error("Expected a streaming response");
      const reader = response.body.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: delta");
      controller.abort();
      await expect.poll(() => generationCancelled).toBe(true);
      await assertReleased();
      expect(
        await admin`select id from assistant_messages where org_id = ${orgId} and content = 'cancel-stream'`,
      ).toHaveLength(0);
    });

    it("commits ticket redemption before socket expiry, pruning and later scoped frames", async () => {
      const issue = () =>
        app.inject({ method: "POST", url: "/v1/api/chat/ws-ticket", payload: { roomId } });
      const issued = await issue();
      expect(issued.statusCode).toBe(200);
      const ticket = issued.json<{ ticket: string }>().ticket;
      const tickets = new PostgresChatWebSocketTicketStore(sql);
      await expect(
        tickets.consume({
          orgId: foreignOrgId,
          ticket,
          audience: "chat.websocket",
          path: "/ws/chat",
        }),
      ).resolves.toBeNull();
      const socket = new WebSocket(`${baseUrl.replace("http:", "ws:")}/v1/ws/chat`, [
        "helix.chat.v1",
        `helix.ticket.${ticket}`,
      ]);
      try {
        await nextFrame(socket, "ready");
        await assertReleased();
        // Expire the redeemed row without waiting 30s; a retained upgrade transaction blocks this write.
        await admin`update chat_websocket_tickets set issued_at = now() - interval '2 minutes',
        expires_at = now() - interval '1 minute' where actor_id = ${actor.id}`;
        expect((await issue()).statusCode).toBe(200);
        const subscribed = nextFrame(socket, "subscribed");
        socket.send(JSON.stringify({ type: "subscribe", roomId }));
        await subscribed;
        await assertReleased();
        const forbidden = nextFrame(socket, "error");
        socket.send(
          JSON.stringify({ type: "subscribe", roomId: "dc120000-0000-4000-8000-000000000022" }),
        );
        expect(await forbidden).toMatchObject({ code: "forbidden" });
      } finally {
        socket.close();
      }
    });

    it("releases event socket authentication locks while the subscription remains open", async () => {
      const before = resolvedActors;
      const socket = new WebSocket(
        `${baseUrl.replace("http:", "ws:")}/v1/events/ws?subject=activity.mail.received`,
      );
      try {
        await expect.poll(() => resolvedActors).toBe(before + 1);
        await assertReleased();
        const delivered = nextFrame(socket, "activity.mail.received", "subject");
        await events.publish("activity.mail.received", { orgId, actorId: actor.id });
        await delivered;
      } finally {
        socket.close();
      }
    });

    it("releases Mail SSE authentication locks while the response remains open", async () => {
      const controller = new AbortController();
      try {
        const response = await fetch(`${baseUrl}/v1/sse/mail`, { signal: controller.signal });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        await assertReleased();
      } finally {
        controller.abort();
      }
    });
  },
);

function nextFrame(
  socket: WebSocket,
  expected: string,
  key = "type",
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", receive);
      reject(new Error(`Missing ${expected} frame`));
    }, 3000);
    const receive = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (frame[key] !== expected) return;
      clearTimeout(timer);
      socket.removeEventListener("message", receive);
      resolve(frame);
    };
    socket.addEventListener("message", receive);
  });
}
