import { describe, expect, it } from "vitest";
import { actorFromRequestWithAccessToken } from "../../api/actor.js";
import { InMemoryOAuthClientStore } from "../auth/oauth.js";
import { handleEventSocket } from "./routes.js";
import type { AccessTokenRecord } from "../auth/oauth.js";
import type { EventBus, EventEnvelope, JsonValue, Unsubscribe } from "@helix/sdk-types";
import type { FastifyRequest } from "fastify";

const actorId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";

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
      payload: { threadId: "thread-1" },
      occurredAt: "2026-05-20T12:00:00.000Z",
    });

    expect(socket.messages).toEqual([
      {
        subject: "mail.thread.created",
        payload: { threadId: "thread-1" },
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

    await handleEventSocket(socket, requestFor({ subject: ">", token: "token-3" }), {
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
});

async function tokenStoreWithAccessToken(token: string): Promise<InMemoryOAuthClientStore> {
  const store = new InMemoryOAuthClientStore();
  const issuedAt = new Date("2026-05-20T12:00:00.000Z");
  const accessToken: AccessTokenRecord = {
    token,
    clientId: "client-1",
    actorId,
    orgId,
    actorType: "agent",
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
