import { describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  InMemorySlidesStore,
  SLIDES_WS_PROTOCOL,
  SLIDES_WS_ROUTE,
  handleSlidesSocket,
  registerSlidesRoutes,
  type SlidesStore,
} from "./index.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const otherActorId = "33333333-3333-4333-8333-333333333333";
const actor: Actor = {
  id: actorId,
  orgId,
  type: "user",
  displayName: "Ada",
};

describe("slides sync routes", () => {
  it("sends ready state, persists slide updates, and broadcasts canonical snapshots", async () => {
    const store = new InMemorySlidesStore();
    const deck = await store.createDeck({ orgId, actorId, title: "Board narrative" });
    const slide = await store.createSlide({
      orgId,
      actorId,
      deckId: deck.id,
      content: { layout: "bullets", title: "Launch", items: ["Plan"] },
      speakerNotes: "Opening",
    });
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const state = { rooms: new Map() };

    await handleSlidesSocket(firstSocket, requestFor(deck.id), options(store), state);
    await handleSlidesSocket(secondSocket, requestFor(deck.id), options(store), state);
    firstSocket.receive({
      type: "operation",
      operationId: "op-1",
      operation: {
        kind: "update-slide",
        slideId: slide.id,
        content: { layout: "bullets", title: "Updated", items: ["Plan", "Risks"] },
        speakerNotes: "Updated notes",
      },
    });
    await settle();

    expect(firstSocket.messages[0]).toMatchObject({
      type: "ready",
      protocol: SLIDES_WS_PROTOCOL,
      deckId: deck.id,
      revision: 0,
      deck: { id: deck.id, title: "Board narrative", slideCount: 1 },
      slides: [{ id: slide.id, speakerNotes: "Opening" }],
    });
    expect(firstSocket.messages.at(-1)).toMatchObject({
      type: "operation",
      protocol: SLIDES_WS_PROTOCOL,
      operationId: "op-1",
      revision: 1,
      slides: [
        {
          id: slide.id,
          content: { layout: "bullets", title: "Updated", items: ["Plan", "Risks"] },
          speakerNotes: "Updated notes",
        },
      ],
    });
    expect(secondSocket.messages.at(-1)).toMatchObject({
      type: "operation",
      operationId: "op-1",
      revision: 1,
    });
    await expect(store.getDeckForActor({ orgId, actorId, deckId: deck.id })).resolves.toMatchObject(
      {
        slides: [
          expect.objectContaining({
            id: slide.id,
            content: { layout: "bullets", title: "Updated", items: ["Plan", "Risks"] },
            speakerNotes: "Updated notes",
          }),
        ],
      },
    );
  });

  it("acks duplicate operation ids without applying them again", async () => {
    const store = new InMemorySlidesStore();
    const deck = await store.createDeck({ orgId, actorId, title: "Idempotent" });
    const slide = await store.createSlide({
      orgId,
      actorId,
      deckId: deck.id,
      content: { layout: "title", title: "Original" },
    });
    const socket = new FakeSocket();

    await handleSlidesSocket(socket, requestFor(deck.id), options(store));
    socket.receive({
      type: "operation",
      operationId: "op-1",
      operation: {
        kind: "update-slide",
        slideId: slide.id,
        content: { layout: "title", title: "Accepted" },
      },
    });
    await settle();
    socket.receive({
      type: "operation",
      operationId: "op-1",
      baseRevision: 1,
      operation: {
        kind: "update-slide",
        slideId: slide.id,
        content: { layout: "title", title: "Duplicate" },
      },
    });
    await settle();

    expect(socket.messages.at(-1)).toEqual({
      type: "ack",
      operationId: "op-1",
      revision: 1,
      duplicate: true,
    });
    await expect(store.getDeckForActor({ orgId, actorId, deckId: deck.id })).resolves.toMatchObject(
      {
        slides: [expect.objectContaining({ content: { layout: "title", title: "Accepted" } })],
      },
    );

    const reconnect = new FakeSocket();
    await handleSlidesSocket(reconnect, requestFor(deck.id), options(store), { rooms: new Map() });
    reconnect.receive({
      type: "operation",
      operationId: "op-1",
      baseRevision: 1,
      operation: {
        kind: "update-slide",
        slideId: slide.id,
        content: { layout: "title", title: "Duplicate after restart" },
      },
    });
    await settle();

    expect(reconnect.messages[0]).toMatchObject({ type: "ready", revision: 1 });
    expect(reconnect.messages.at(-1)).toEqual({
      type: "ack",
      operationId: "op-1",
      revision: 1,
      duplicate: true,
    });
  });

  it("rejects operations whose base revision is ahead of durable sync state", async () => {
    const store = new InMemorySlidesStore();
    const deck = await store.createDeck({ orgId, actorId, title: "Ahead" });
    const slide = await store.createSlide({
      orgId,
      actorId,
      deckId: deck.id,
      content: { layout: "title", title: "Original" },
    });
    const socket = new FakeSocket();

    await handleSlidesSocket(socket, requestFor(deck.id), options(store));
    socket.receive({
      type: "operation",
      operationId: "op-ahead",
      baseRevision: 2,
      operation: {
        kind: "update-slide",
        slideId: slide.id,
        content: { layout: "title", title: "Future" },
      },
    });
    await settle();

    expect(socket.messages.at(-1)).toEqual({
      type: "error",
      operationId: "op-ahead",
      revision: 0,
      error: "Slides operation base revision is ahead of the server revision.",
    });
    await expect(store.listOperations({ orgId, actorId, deckId: deck.id })).resolves.toEqual([]);
  });

  it("broadcasts ephemeral awareness to peers and includes active peers on join", async () => {
    const store = new InMemorySlidesStore();
    const deck = await store.createDeck({ orgId, actorId, title: "Presence" });
    const slide = await store.createSlide({
      orgId,
      actorId,
      deckId: deck.id,
      content: { layout: "title", title: "Shared slide" },
    });
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const state = { rooms: new Map() };

    await handleSlidesSocket(firstSocket, requestFor(deck.id), options(store), state);
    await handleSlidesSocket(secondSocket, requestFor(deck.id), options(store), state);
    firstSocket.receive({
      type: "awareness",
      selectedSlideId: slide.id,
      selectedShapeId: "shape-1",
      mode: "presenting",
    });
    await settle();

    expect(firstSocket.messages).toHaveLength(1);
    expect(secondSocket.messages.at(-1)).toMatchObject({
      type: "awareness",
      protocol: SLIDES_WS_PROTOCOL,
      deckId: deck.id,
      actorId,
      displayName: "Ada",
      selectedSlideId: slide.id,
      selectedShapeId: "shape-1",
      mode: "presenting",
      status: "active",
    });

    const thirdSocket = new FakeSocket();
    await handleSlidesSocket(thirdSocket, requestFor(deck.id), options(store), state);
    expect(thirdSocket.messages[0]).toMatchObject({
      type: "ready",
      awareness: [
        expect.objectContaining({
          actorId,
          selectedSlideId: slide.id,
          selectedShapeId: "shape-1",
          mode: "presenting",
        }),
      ],
    });

    firstSocket.close();
    expect(secondSocket.messages.at(-1)).toMatchObject({
      type: "awareness",
      actorId,
      status: "left",
    });
  });

  it("rejects cross-deck slide mutation attempts without broadcasting", async () => {
    const store = new InMemorySlidesStore();
    const firstDeck = await store.createDeck({ orgId, actorId, title: "First" });
    const secondDeck = await store.createDeck({ orgId, actorId, title: "Second" });
    const secondSlide = await store.createSlide({
      orgId,
      actorId,
      deckId: secondDeck.id,
      content: { layout: "title", title: "Second slide" },
    });
    const socket = new FakeSocket();

    await handleSlidesSocket(socket, requestFor(firstDeck.id), options(store));
    socket.receive({
      type: "operation",
      operationId: "op-cross",
      operation: {
        kind: "update-slide",
        slideId: secondSlide.id,
        content: { layout: "title", title: "Wrong room" },
      },
    });
    await settle();

    expect(JSON.stringify(socket.messages.at(-1))).toContain("Unknown or inaccessible slide");
    await expect(
      store.getDeckForActor({ orgId, actorId, deckId: secondDeck.id }),
    ).resolves.toMatchObject({
      slides: [expect.objectContaining({ content: { layout: "title", title: "Second slide" } })],
    });
  });

  it("closes inaccessible decks before registering message handlers", async () => {
    const store = new InMemorySlidesStore();
    const deck = await store.createDeck({ orgId, actorId: otherActorId, title: "Private" });
    const socket = new FakeSocket();

    await handleSlidesSocket(socket, requestFor(deck.id), options(store));

    expect(socket.closed).toEqual({
      code: 1008,
      reason: "Unknown or inaccessible presentation",
    });
    expect(socket.messageHandlerCount).toBe(0);
  });

  it("tracks active websocket metrics with the slides route label", async () => {
    const store = new InMemorySlidesStore();
    const deck = await store.createDeck({ orgId, actorId, title: "Metrics" });
    const socket = new FakeSocket();
    const metrics = new RecordingWebsocketMetrics();

    await handleSlidesSocket(socket, requestFor(deck.id), options(store, { metrics }));
    socket.close();

    expect(metrics.events).toEqual([`open:${SLIDES_WS_ROUTE}`, `close:${SLIDES_WS_ROUTE}`]);
  });
});

describe("registerSlidesRoutes", () => {
  it("mounts the slides websocket route", async () => {
    const app = captureWebsocketApp();
    const store = new InMemorySlidesStore();

    await registerSlidesRoutes(app.app, options(store));

    expect(app.path).toBe(SLIDES_WS_ROUTE);
  });
});

function options(
  store: SlidesStore,
  overrides: {
    readonly metrics?: RecordingWebsocketMetrics | undefined;
  } = {},
): Parameters<typeof handleSlidesSocket>[2] {
  return {
    store,
    actorFromRequest: () => actor,
    ...(overrides.metrics === undefined ? {} : { metrics: overrides.metrics }),
  };
}

function requestFor(deckId: string): FastifyRequest {
  return {
    params: { deckId },
    query: { protocol: SLIDES_WS_PROTOCOL },
  } as unknown as FastifyRequest;
}

function captureWebsocketApp(): {
  readonly app: FastifyInstance;
  readonly path: string | undefined;
} {
  let path: string | undefined;
  const app = {
    get: (registeredPath: string) => {
      path = registeredPath;
    },
  } as unknown as FastifyInstance;
  return {
    app,
    get path() {
      return path;
    },
  };
}

class FakeSocket {
  readonly messages: unknown[] = [];
  closed: { readonly code?: number; readonly reason?: string } | null = null;
  #messageHandlers: Array<(data: Buffer | ArrayBuffer | string) => void> = [];
  #closeHandlers: Array<() => void> = [];

  get messageHandlerCount(): number {
    return this.#messageHandlers.length;
  }

  send(data: string | Buffer): void {
    this.messages.push(JSON.parse(Buffer.from(data).toString("utf8")));
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

  on(event: "message", handler: (data: Buffer | ArrayBuffer | string) => void): void;
  on(event: "close", handler: () => void): void;
  on(_event: "error", _handler: (error: Error) => void): void;
  on(
    event: "message" | "close" | "error",
    handler:
      | ((data: Buffer | ArrayBuffer | string) => void)
      | (() => void)
      | ((error: Error) => void),
  ): void {
    if (event === "message") {
      this.#messageHandlers.push(handler as (data: Buffer | ArrayBuffer | string) => void);
      return;
    }
    if (event === "close") {
      this.#closeHandlers.push(handler as () => void);
    }
  }

  receive(message: unknown): void {
    for (const handler of this.#messageHandlers) {
      handler(JSON.stringify(message));
    }
  }
}

class RecordingWebsocketMetrics {
  readonly events: string[] = [];

  recordWebsocketConnectionOpened(input: { readonly route: string }): void {
    this.events.push(`open:${input.route}`);
  }

  recordWebsocketConnectionClosed(input: { readonly route: string }): void {
    this.events.push(`close:${input.route}`);
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
