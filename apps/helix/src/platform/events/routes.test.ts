import { describe, expect, it } from "vitest";
import { actorFromRequestWithAccessToken } from "../../api/actor.js";
import { InMemoryOAuthClientStore } from "../auth/oauth.js";
import { handleEventSocket } from "./routes.js";
import { EventStreamLimiter } from "./stream-limit.js";
import type { AccessTokenRecord } from "../auth/oauth.js";
import type { EventBus, EventEnvelope, JsonValue, Unsubscribe } from "@helix/sdk-types";
import type { FastifyRequest } from "fastify";

const actorId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";
const otherOrgId = "33333333-3333-4333-8333-333333333333";

describe("events websocket routes", () => {
  it("authenticates bearer tokens, subscribes to subject filters, and sends event envelopes", async () => {
    const tokenStore = await tokenStoreWithAccessToken("token-1");
    const socket = new FakeSocket();
    const bus = new FakeEventBus();

    await handleEventSocket(
      socket,
      requestFor({ subject: "mail.thread.created", token: "token-1" }),
      {
        bus,
        actorFromRequest: (request) => actorFromRequestWithAccessToken(request, tokenStore),
      },
    );

    expect(bus.subjects).toEqual(["mail.thread.created"]);

    await bus.emit({
      subject: "mail.thread.created",
      payload: { orgId, threadId: "thread-1" },
      occurredAt: "2026-05-20T12:00:00.000Z",
    });

    expect(socket.messages).toEqual([
      {
        subject: "mail.thread.created",
        payload: { orgId, threadId: "thread-1" },
        occurredAt: "2026-05-20T12:00:00.000Z",
      },
    ]);
  });

  it("cleans up event bus subscriptions when the socket closes", async () => {
    const tokenStore = await tokenStoreWithAccessToken("token-2");
    const socket = new FakeSocket();
    const bus = new FakeEventBus();

    await handleEventSocket(socket, requestFor({ subject: "calendar.>", token: "token-2" }), {
      bus,
      actorFromRequest: (request) => actorFromRequestWithAccessToken(request, tokenStore),
    });
    socket.close();
    await settle();

    expect(bus.unsubscribeCount).toBe(1);
  });

  it("fails explicitly when the event bus is unavailable", async () => {
    const tokenStore = await tokenStoreWithAccessToken("token-3");
    const socket = new FakeSocket();

    await handleEventSocket(socket, requestFor({ subject: "platform.>", token: "token-3" }), {
      actorFromRequest: (request) => actorFromRequestWithAccessToken(request, tokenStore),
    });

    expect(socket.closed).toEqual({
      code: 1013,
      reason: "Event bus unavailable",
    });
  });

  it("rejects missing bearer authentication before subscribing", async () => {
    const socket = new FakeSocket();
    const bus = new FakeEventBus();
    const tokenStore = new InMemoryOAuthClientStore();

    await handleEventSocket(socket, requestFor({ subject: "platform.pending_action.created" }), {
      bus,
      actorFromRequest: (request) => actorFromRequestWithAccessToken(request, tokenStore),
    });

    expect(socket.closed).toEqual({
      code: 1008,
      reason: "Authentication required",
    });
    expect(bus.subjects).toEqual([]);
  });

  it("rejects missing or invalid subject query parameters", async () => {
    const tokenStore = await tokenStoreWithAccessToken("token-4");
    const socket = new FakeSocket();
    const bus = new FakeEventBus();

    await handleEventSocket(socket, requestFor({ subject: "bad..subject", token: "token-4" }), {
      bus,
      actorFromRequest: (request) => actorFromRequestWithAccessToken(request, tokenStore),
    });

    expect(socket.closed).toEqual({
      code: 1008,
      reason: "Missing or invalid subject query parameter",
    });
    expect(bus.subjects).toEqual([]);
  });

  it.each(["chat.>", `chat.org.${orgId}.room.victim-room.events`, ">", "*.>"])(
    "rejects Chat-capable generic event subscriptions: %s",
    async (subject) => {
      const tokenStore = await tokenStoreWithAccessToken("token-chat");
      const socket = new FakeSocket();
      const bus = new FakeEventBus();

      await handleEventSocket(socket, requestFor({ subject, token: "token-chat" }), {
        bus,
        actorFromRequest: (request) => actorFromRequestWithAccessToken(request, tokenStore),
      });

      expect(socket.closed).toEqual({
        code: 1008,
        reason: "Chat events require the room-authorized Chat WebSocket",
      });
      expect(bus.subjects).toEqual([]);
    },
  );

  it("drops globally-named envelopes that name another tenant", async () => {
    const { socket, bus } = await connect({
      token: "token-cross-tenant",
      subject: "platform.ai_cost.warning",
    });

    await bus.emit({
      subject: "platform.ai_cost.warning",
      payload: { orgId: otherOrgId, actorId: "victim-actor", feature: "mail.summarize" },
      occurredAt: "2026-05-20T12:00:00.000Z",
    });

    expect(socket.messages).toEqual([]);
  });

  it("delivers globally-named envelopes that name the subscriber's own tenant", async () => {
    const { socket, bus } = await connect({
      token: "token-own-tenant",
      subject: "platform.ai_cost.warning",
    });

    await bus.emit({
      subject: "platform.ai_cost.warning",
      payload: { orgId, actorId, feature: "mail.summarize" },
      occurredAt: "2026-05-20T12:00:00.000Z",
    });

    expect(socket.messages).toHaveLength(1);
  });

  it("drops envelopes whose foreign org marker is nested rather than top level", async () => {
    const { socket, bus } = await connect({
      token: "token-nested",
      subject: "platform.pending_action.created",
    });

    await bus.emit({
      subject: "platform.pending_action.created",
      payload: {
        id: "pending-1",
        record: { actor: { id: "victim-actor", orgId: otherOrgId } },
      },
      occurredAt: "2026-05-20T12:00:00.000Z",
    });

    expect(socket.messages).toEqual([]);
  });

  it("drops unmarked envelopes on subjects that are not known-global", async () => {
    const { socket, bus } = await connect({
      token: "token-unmarked",
      subject: "billing.invoice.finalized",
    });

    // An org-scoped event that forgot its orgId looks exactly like a global one
    // from here, so the fail-closed default drops it rather than fanning it out
    // to every tenant.
    await bus.emit({
      subject: "billing.invoice.finalized",
      payload: { invoiceId: "inv-1", totalCents: 1000 },
      occurredAt: "2026-05-20T12:00:00.000Z",
    });

    expect(socket.messages).toEqual([]);
  });

  it("refuses a connection once the workspace is at its concurrent-stream ceiling", async () => {
    /* `/events/ws` is exempt from the tenant request-rate meter — a rate limit
       is the wrong control for a connection that lives for minutes, and under
       it the admin console's own sockets competed with the section's queries.
       This cap is what replaced it, so it is the only thing bounding how many
       streams one workspace can hold open. */
    const streamLimiter = new EventStreamLimiter({ maxPerOrg: 1 });

    const first = await connect({
      token: "token-cap-1",
      subject: "platform.ai_cost.warning",
      streamLimiter,
    });
    expect(first.socket.closed).toBeNull();

    const second = await connect({
      token: "token-cap-2",
      subject: "platform.ai_cost.warning",
      streamLimiter,
    });

    expect(second.socket.closed).toEqual({
      code: 1013,
      reason: "Too many concurrent event streams for this workspace",
    });
    // Refused before subscribing, so a rejected upgrade costs the bus nothing.
    expect(second.bus.subjects).toEqual([]);
  });

  it("returns a stream slot to the workspace when the socket closes", async () => {
    const streamLimiter = new EventStreamLimiter({ maxPerOrg: 1 });

    const first = await connect({
      token: "token-release-1",
      subject: "platform.ai_cost.warning",
      streamLimiter,
    });
    first.socket.close();
    await settle();

    const second = await connect({
      token: "token-release-2",
      subject: "platform.ai_cost.warning",
      streamLimiter,
    });

    expect(second.socket.closed).toBeNull();
  });

  it("delivers platform-wide config changes to every tenant", async () => {
    const { socket, bus } = await connect({
      token: "token-config",
      subject: "helix.config.changed",
    });

    /* `helix.config.changed` is deployment-wide, not org-scoped — there is no
       org at its publish site, and its payload is configuration key *names*.
       Dropping it as "unmarked" silently disabled the admin console's Tier
       readiness, AI providers and Overview liveness while the socket still
       reported itself healthy, which is the worst of both outcomes. */
    await bus.emit({
      subject: "helix.config.changed",
      payload: { actorId: "someone-else", keys: ["security.tier"] },
      occurredAt: "2026-05-20T12:00:00.000Z",
    });

    expect(socket.messages).toHaveLength(1);
  });

  it("delivers unmarked envelopes on explicitly allowlisted global subjects", async () => {
    const { socket, bus } = await connect({
      token: "token-global",
      subject: "signup.form_viewed",
    });

    await bus.emit({
      subject: "signup.form_viewed",
      payload: { step: "form_viewed", source: "signup", page: "/signup" },
      occurredAt: "2026-05-20T12:00:00.000Z",
    });

    expect(socket.messages).toHaveLength(1);
  });

  it("keeps delivering the subscriber's own org on subject-name-scoped wildcards", async () => {
    const { socket, bus } = await connect({ token: "token-flags", subject: "flags.changed.*" });

    await bus.emit({
      subject: `flags.changed.${orgId}`,
      payload: { orgId, changedByActorId: actorId, keys: ["mail.beta"] },
      occurredAt: "2026-05-20T12:00:00.000Z",
    });
    await bus.emit({
      subject: `flags.changed.${otherOrgId}`,
      payload: { orgId: otherOrgId, changedByActorId: "victim-actor", keys: ["mail.beta"] },
      occurredAt: "2026-05-20T12:00:00.000Z",
    });

    expect(socket.messages).toEqual([
      {
        subject: `flags.changed.${orgId}`,
        payload: { orgId, changedByActorId: actorId, keys: ["mail.beta"] },
        occurredAt: "2026-05-20T12:00:00.000Z",
      },
    ]);
  });

  it("exempts the system actor, matching actorHasScope", async () => {
    const { socket, bus } = await connect({
      token: "token-system",
      subject: "platform.ai_cost.warning",
      actorType: "system",
    });

    await bus.emit({
      subject: "platform.ai_cost.warning",
      payload: { orgId: otherOrgId, actorId: "victim-actor" },
      occurredAt: "2026-05-20T12:00:00.000Z",
    });

    expect(socket.messages).toHaveLength(1);
  });
});

async function connect(input: {
  readonly token: string;
  readonly subject: string;
  readonly actorType?: AccessTokenRecord["actorType"];
  readonly streamLimiter?: EventStreamLimiter;
}): Promise<{ readonly socket: FakeSocket; readonly bus: FakeEventBus }> {
  const tokenStore = await tokenStoreWithAccessToken(input.token, input.actorType);
  const socket = new FakeSocket();
  const bus = new FakeEventBus();

  await handleEventSocket(socket, requestFor({ subject: input.subject, token: input.token }), {
    bus,
    actorFromRequest: (request) => actorFromRequestWithAccessToken(request, tokenStore),
    ...(input.streamLimiter === undefined ? {} : { streamLimiter: input.streamLimiter }),
  });

  return { socket, bus };
}

async function tokenStoreWithAccessToken(
  token: string,
  actorType: AccessTokenRecord["actorType"] = "agent",
): Promise<InMemoryOAuthClientStore> {
  const store = new InMemoryOAuthClientStore();
  const issuedAt = new Date("2026-05-20T12:00:00.000Z");
  const accessToken: AccessTokenRecord = {
    token,
    clientId: "client-1",
    actorId,
    orgId,
    actorType,
    scopes: ["platform.read"],
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 60_000),
  };
  await store.saveToken(accessToken);
  return store;
}

function requestFor(input: { readonly subject?: string; readonly token?: string }): FastifyRequest {
  return {
    headers: input.token === undefined ? {} : { authorization: `Bearer ${input.token}` },
    query: input.subject === undefined ? {} : { subject: input.subject },
  } as FastifyRequest;
}

class FakeSocket {
  readonly messages: Record<string, unknown>[] = [];
  readonly #closeHandlers: (() => void)[] = [];
  readonly #errorHandlers: ((error: Error) => void)[] = [];
  closed: { readonly code?: number; readonly reason?: string } | null = null;

  send(data: string): void {
    this.messages.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    this.closed = {
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    };
    for (const handler of this.#closeHandlers) {
      handler();
    }
  }

  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  on(event: "close" | "error", handler: (() => void) | ((error: Error) => void)): void {
    if (event === "close") {
      this.#closeHandlers.push(handler as () => void);
      return;
    }
    this.#errorHandlers.push(handler);
  }
}

class FakeEventBus implements EventBus {
  readonly subjects: string[] = [];
  unsubscribeCount = 0;
  #handler: ((event: EventEnvelope) => Promise<void>) | undefined;

  async publish(): Promise<void> {}

  async subscribe<Payload extends JsonValue>(
    subject: string,
    handler: (event: EventEnvelope<Payload>) => Promise<void>,
  ): Promise<Unsubscribe> {
    this.subjects.push(subject);
    this.#handler = handler as (event: EventEnvelope) => Promise<void>;
    return () => {
      this.unsubscribeCount += 1;
      this.#handler = undefined;
    };
  }

  async emit(event: EventEnvelope): Promise<void> {
    await this.#handler?.(event);
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
