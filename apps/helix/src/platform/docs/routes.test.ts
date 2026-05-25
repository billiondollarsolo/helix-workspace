import { describe, expect, it } from "vitest";
import type {
  Actor,
  JsonObject,
  MeteringClient,
  MeteringEmitInput,
  MeteringEvent,
  TraceContext,
} from "@helix/sdk-types";
import type { FastifyRequest } from "fastify";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import type { FastifyInstance } from "fastify";
import { handleDocsSocket, registerDocsRoutes } from "./routes.js";
import type { DocsStore } from "./store.js";
import type {
  DocsAskHistoryRecord,
  DocsCommentRecord,
  DocsDocumentRecord,
  DocsExportDocument,
  DocsExportFormat,
  DocsExportRecord,
  DocsSuggestionRecord,
  DocsUpdateRecord,
} from "./types.js";

const now = new Date("2026-05-20T12:00:00.000Z");
const docId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";
const actor: Actor = {
  id: "33333333-3333-4333-8333-333333333333",
  orgId,
  type: "user",
  displayName: "Ada",
};

describe("docs sync routes", () => {
  it("sends ready state, broadcasts updates, and compacts the latest state", async () => {
    const store = new FakeDocsStore();
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const state = {
      rooms: new Map<string, Set<Parameters<typeof handleDocsSocket>[0]>>(),
      compactions: new Map<string, NodeJS.Timeout>(),
    };

    await handleDocsSocket(firstSocket, requestFor(docId), options(store), state);
    await handleDocsSocket(secondSocket, requestFor(docId), options(store), state);
    firstSocket.receive({
      type: "update",
      updateBase64: Buffer.from("incremental update", "utf8").toString("base64"),
      stateBase64: Buffer.from("# Synced title\n", "utf8").toString("base64"),
      metadata: { source: "test" },
    });
    await settle();

    expect(firstSocket.messages[0]).toMatchObject({
      type: "ready",
      documentId: docId,
      updateSeq: 4,
      stateBase64: Buffer.from("# Initial title\n", "utf8").toString("base64"),
    });
    expect(secondSocket.messages[0]).toMatchObject({ type: "ready", documentId: docId });
    expect(firstSocket.messages.map((message) => message.type)).toContain("update");
    expect(secondSocket.messages.map((message) => message.type)).toContain("update");
    expect(store.updates).toEqual([
      {
        actorId: actor.id,
        documentId: docId,
        metadata: {
          source: "test",
          stateBase64: Buffer.from("# Synced title\n", "utf8").toString("base64"),
        },
        text: "incremental update",
      },
    ]);
    expect(store.compactions).toEqual([
      { documentId: docId, stateVectorPersisted: false, text: "# Synced title\n" },
    ]);
  });

  it("closes inaccessible documents before registering message handlers", async () => {
    const store = new FakeDocsStore({ accessible: false });
    const socket = new FakeSocket();

    await handleDocsSocket(socket, requestFor(docId), options(store));

    expect(store.accessChecks).toEqual([docId]);
    expect(socket.closed).toEqual({
      code: 1008,
      reason: "Unknown or inaccessible document",
    });
    expect(socket.messageHandlerCount).toBe(0);
  });

  it("enforces the concurrent editor quota across legacy and Yjs sockets", async () => {
    const store = new FakeDocsStore();
    const legacySocket = new FakeSocket();
    const blockedYjsSocket = new FakeSocket();
    const state = {
      rooms: new Map<string, Set<Parameters<typeof handleDocsSocket>[0]>>(),
      compactions: new Map<string, NodeJS.Timeout>(),
      yjsRooms: new Map(),
    };
    const routeOptions = options(store, { concurrentEditorLimit: 1 });

    await handleDocsSocket(legacySocket, requestFor(docId), routeOptions, state);
    await handleDocsSocket(blockedYjsSocket, yjsRequestFor(docId), routeOptions, state);

    expect(legacySocket.closed).toBeNull();
    expect(blockedYjsSocket.closed).toEqual({
      code: 1008,
      reason: "Concurrent editor quota exceeded",
    });
    expect(blockedYjsSocket.messageHandlerCount).toBe(0);

    legacySocket.close();
    const nextYjsSocket = new FakeSocket();
    await handleDocsSocket(nextYjsSocket, yjsRequestFor(docId), routeOptions, state);

    expect(nextYjsSocket.closed).toBeNull();
    expect(nextYjsSocket.binaryMessages.length).toBeGreaterThan(0);
  });

  it("treats a null concurrent editor quota as unlimited", async () => {
    const store = new FakeDocsStore();
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const state = {
      rooms: new Map<string, Set<Parameters<typeof handleDocsSocket>[0]>>(),
      compactions: new Map<string, NodeJS.Timeout>(),
      yjsRooms: new Map(),
    };

    await handleDocsSocket(
      firstSocket,
      requestFor(docId),
      options(store, { concurrentEditorLimit: null }),
      state,
    );
    await handleDocsSocket(
      secondSocket,
      yjsRequestFor(docId),
      options(store, { concurrentEditorLimit: null }),
      state,
    );

    expect(firstSocket.closed).toBeNull();
    expect(secondSocket.closed).toBeNull();
    expect(secondSocket.binaryMessages.length).toBeGreaterThan(0);
  });

  it("emits collab session metering after accepted docs sockets close", async () => {
    const store = new FakeDocsStore();
    const metering = new RecordingMeteringClient();
    const socket = new FakeSocket();
    const nowValues = [1_000, 4_400];

    await handleDocsSocket(
      socket,
      requestFor(docId),
      options(store, {
        metering,
        nowMs: () => nowValues.shift() ?? 4_400,
      }),
    );

    socket.close();
    await settle();

    expect(metering.records).toEqual([
      {
        orgId,
        event: {
          type: "collab.session.opened",
          quantity: 3,
          metadata: {
            surface: "docs.sync",
            protocol: "legacy-json",
            duration_seconds: 3,
          },
        },
        trace: undefined,
      },
    ]);
    expect(JSON.stringify(metering.records)).not.toContain(docId);
    expect(JSON.stringify(metering.records)).not.toContain(actor.id);
  });

  it("does not meter rejected docs sockets", async () => {
    const store = new FakeDocsStore({ accessible: false });
    const metering = new RecordingMeteringClient();
    const socket = new FakeSocket();

    await handleDocsSocket(socket, requestFor(docId), options(store, { metering }));

    socket.close();
    await settle();

    expect(metering.records).toEqual([]);
  });

  it("supports Yjs sync protocol frames, persisted updates, peer broadcast, and compaction", async () => {
    const store = new FakeDocsStore();
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const state = {
      rooms: new Map<string, Set<Parameters<typeof handleDocsSocket>[0]>>(),
      compactions: new Map<string, NodeJS.Timeout>(),
    };

    await handleDocsSocket(firstSocket, yjsRequestFor(docId), options(store), state);
    await handleDocsSocket(secondSocket, yjsRequestFor(docId), options(store), state);

    expect(firstSocket.messages).toEqual([]);
    expect(firstSocket.binaryMessages.length).toBeGreaterThan(0);

    const clientDoc = new Y.Doc();
    firstSocket.receiveRaw(syncStep1Message(clientDoc));
    const syncReply = firstSocket.binaryMessages.at(-1);
    if (syncReply === undefined) {
      throw new Error("Expected server sync reply.");
    }
    applySyncMessage(clientDoc, syncReply);
    expect(clientDoc.getText("markdown").toJSON()).toBe("# Initial title\n");

    const updateDoc = new Y.Doc();
    updateDoc.getText("markdown").insert(0, "# Synced Yjs title\n");
    firstSocket.receiveRaw(syncUpdateMessage(Y.encodeStateAsUpdate(updateDoc)));
    await settle();

    expect(store.updates).toHaveLength(1);
    expect(store.updates[0]).toMatchObject({
      actorId: actor.id,
      documentId: docId,
      metadata: { protocol: "yjs" },
    });
    expect(secondSocket.binaryMessages.length).toBeGreaterThan(1);
    expect(store.compactions).toHaveLength(1);
    expect(store.compactions[0]).toMatchObject({
      documentId: docId,
      stateVectorPersisted: true,
    });
    expect(store.compactions[0]?.text).toContain("# Initial title\n");
    expect(store.compactions[0]?.text).toContain("# Synced Yjs title\n");
  });
});

function options(
  store: DocsStore,
  overrides: {
    readonly concurrentEditorLimit?: number | null;
    readonly metering?: MeteringClient | undefined;
    readonly nowMs?: (() => number) | undefined;
  } = {},
): Parameters<typeof handleDocsSocket>[2] {
  return {
    store,
    actorFromRequest: () => actor,
    ...(overrides.concurrentEditorLimit === undefined
      ? {}
      : { concurrentEditorLimit: () => overrides.concurrentEditorLimit }),
    ...(overrides.metering === undefined ? {} : { metering: overrides.metering }),
    ...(overrides.nowMs === undefined ? {} : { nowMs: overrides.nowMs }),
    debounceMs: 0,
  };
}

/**
 * Minimal Fastify stand-in that captures the websocket handler registered by
 * `registerDocsRoutes` so a test can drive sockets through it and then invoke
 * the returned graceful-shutdown handle (PRD §16.3 step 4).
 */
function captureWebsocketApp(): {
  readonly app: FastifyInstance;
  readonly connect: (socket: FakeSocket, request: FastifyRequest) => Promise<void>;
} {
  let handler: ((socket: unknown, request: FastifyRequest) => Promise<void>) | undefined;
  const app = {
    get: (_path: string, _opts: unknown, registered: typeof handler) => {
      handler = registered;
    },
  } as unknown as FastifyInstance;
  return {
    app,
    connect: async (socket, request) => {
      if (handler === undefined) {
        throw new Error("No websocket handler registered.");
      }
      await handler(socket, request);
    },
  };
}

describe("docs graceful-shutdown broadcast (PRD §16.3 step 4)", () => {
  it("sends a host-shutting-down frame and closes plain-JSON sync sockets", async () => {
    const store = new FakeDocsStore();
    const { app, connect } = captureWebsocketApp();
    const handle = await registerDocsRoutes(app, options(store));

    const socket = new FakeSocket();
    await connect(socket, requestFor(docId));

    handle.broadcastShutdown();

    expect(socket.messages.at(-1)).toEqual({
      type: "shutdown",
      reason: "host shutting down",
    });
    expect(socket.closed).toEqual({ code: 1001, reason: "host shutting down" });
  });

  it("closes Yjs-protocol sockets cleanly with the shutdown close frame", async () => {
    const store = new FakeDocsStore();
    const { app, connect } = captureWebsocketApp();
    const handle = await registerDocsRoutes(app, options(store));

    const socket = new FakeSocket();
    await connect(socket, yjsRequestFor(docId));

    handle.broadcastShutdown();

    expect(socket.closed).toEqual({ code: 1001, reason: "host shutting down" });
  });

  it("does not reach sockets that already disconnected", async () => {
    const store = new FakeDocsStore();
    const { app, connect } = captureWebsocketApp();
    const handle = await registerDocsRoutes(app, options(store));

    const socket = new FakeSocket();
    await connect(socket, requestFor(docId));
    socket.close();
    const messagesBefore = socket.messages.length;

    handle.broadcastShutdown();

    expect(socket.messages.length).toBe(messagesBefore);
  });
});

describe("docs yjs.sync span coverage (P2-6)", () => {
  it("emits a yjs.sync span parented to the upgrade-request trace context", async () => {
    const { installSpanCapture } = await import("../observability/span-testing.js");
    const harness = installSpanCapture();
    try {
      const store = new FakeDocsStore();
      const socket = new FakeSocket();
      const traceId = "0af7651916cd43dd8448eb211c80319c";
      const request = {
        params: { docId },
        headers: { traceparent: `00-${traceId}-b7ad6b7169203331-01` },
      } as unknown as FastifyRequest;

      await handleDocsSocket(socket, request, options(store), {
        rooms: new Map(),
        compactions: new Map(),
      });
      socket.receive({
        type: "update",
        updateBase64: Buffer.from("trace update", "utf8").toString("base64"),
        metadata: {},
      });
      await settle();

      const span = harness.spans().find((candidate) => candidate.name === "yjs.sync");
      expect(span).toBeDefined();
      expect(span?.attributes["helix.docs.document_id"]).toBe(docId);
      expect(span?.spanContext().traceId).toBe(traceId);
    } finally {
      await harness.dispose();
    }
  });
});

function requestFor(documentId: string): FastifyRequest {
  return { params: { docId: documentId } } as FastifyRequest;
}

function yjsRequestFor(documentId: string): FastifyRequest {
  return { params: { docId: documentId }, query: { protocol: "yjs" } } as FastifyRequest;
}

class FakeSocket {
  readonly messages: Record<string, unknown>[] = [];
  readonly binaryMessages: Buffer[] = [];
  readonly #messageHandlers: ((data: Buffer | string) => void)[] = [];
  readonly #closeHandlers: (() => void)[] = [];
  readonly #errorHandlers: ((error: Error) => void)[] = [];
  closed: { readonly code?: number; readonly reason?: string } | null = null;

  get messageHandlerCount(): number {
    return this.#messageHandlers.length;
  }

  send(data: string | Buffer): void {
    if (Buffer.isBuffer(data)) {
      this.binaryMessages.push(data);
      return;
    }
    const raw = Buffer.isBuffer(data) ? data.toString("utf8") : data;
    this.messages.push(JSON.parse(raw) as Record<string, unknown>);
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

  on(event: "message", handler: (data: Buffer | string) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  on(
    event: "message" | "close" | "error",
    handler: ((data: Buffer | string) => void) | (() => void) | ((error: Error) => void),
  ): void {
    if (event === "message") {
      this.#messageHandlers.push(handler as (data: Buffer | string) => void);
      return;
    }
    if (event === "close") {
      this.#closeHandlers.push(handler as () => void);
      return;
    }
    this.#errorHandlers.push(handler as (error: Error) => void);
  }

  receive(payload: unknown): void {
    for (const handler of this.#messageHandlers) {
      handler(JSON.stringify(payload));
    }
  }

  receiveRaw(payload: Buffer): void {
    for (const handler of this.#messageHandlers) {
      handler(payload);
    }
  }
}

class FakeDocsStore implements DocsStore {
  readonly accessChecks: string[] = [];
  readonly updates: Array<{
    readonly actorId: string | null | undefined;
    readonly documentId: string;
    readonly metadata: JsonObject;
    readonly text: string;
  }> = [];
  readonly compactions: Array<{
    readonly documentId: string;
    readonly stateVectorPersisted: boolean;
    readonly text: string;
  }> = [];
  #seq = 4;

  constructor(private readonly optionsInput: { readonly accessible?: boolean } = {}) {}

  async create(): Promise<DocsDocumentRecord> {
    return documentRecord();
  }

  async updateTitle(): Promise<DocsDocumentRecord | null> {
    return documentRecord();
  }

  async updateLayout(): Promise<DocsDocumentRecord | null> {
    return documentRecord();
  }

  async listDocumentsForActor(): Promise<readonly DocsDocumentRecord[]> {
    return [documentRecord()];
  }

  async export(input: { readonly format: DocsExportFormat }): Promise<DocsExportRecord | null> {
    return {
      documentId: docId,
      title: "Initial title",
      format: input.format,
      filename: `initial-title.${input.format}`,
      mimeType: "text/plain",
      contentBase64: Buffer.from("# Initial title\n", "utf8").toString("base64"),
      exportedAt: now,
    };
  }

  async createComment(): Promise<DocsCommentRecord> {
    return {
      id: "44444444-4444-4444-8444-444444444444",
      orgId,
      documentId: docId,
      parentCommentId: null,
      actorId: actor.id,
      anchor: {},
      body: "Comment",
      status: "open",
      metadata: {},
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async listComments(): Promise<readonly DocsCommentRecord[]> {
    return [await this.createComment()];
  }

  async resolveComment(): Promise<DocsCommentRecord | null> {
    return {
      ...(await this.createComment()),
      status: "resolved",
      resolvedAt: now,
    };
  }

  async reopenComment(): Promise<DocsCommentRecord | null> {
    return {
      ...(await this.createComment()),
      status: "open",
      resolvedAt: null,
    };
  }

  async updateComment(
    input: Parameters<DocsStore["updateComment"]>[0],
  ): Promise<DocsCommentRecord | null> {
    return {
      ...(await this.createComment()),
      body: input.body,
      updatedAt: now,
    };
  }

  async deleteComment(): Promise<DocsCommentRecord | null> {
    return this.createComment();
  }

  async createSuggestion(
    input: Parameters<DocsStore["createSuggestion"]>[0],
  ): Promise<DocsSuggestionRecord> {
    return {
      id: "66666666-6666-4666-8666-666666666666",
      orgId: input.orgId,
      documentId: input.documentId,
      actorId: input.actorId,
      anchor: input.anchor ?? {},
      beforeText: input.beforeText,
      afterText: input.afterText,
      reason: input.reason ?? "",
      status: "pending",
      metadata: input.metadata ?? {},
      resolvedByActorId: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async listSuggestions(): Promise<readonly DocsSuggestionRecord[]> {
    return [];
  }

  async listVersions(): Promise<readonly DocsUpdateRecord[]> {
    return [];
  }

  async nameVersion(): Promise<DocsUpdateRecord | null> {
    return null;
  }

  async previewVersion(): Promise<null> {
    return null;
  }

  async restoreVersion(): Promise<null> {
    return null;
  }

  async migrateToNativeDocument(): Promise<DocsDocumentRecord | null> {
    return documentRecord({ editorEngine: "helix-native-document", updateSeq: this.#seq + 1 });
  }

  async resolveSuggestion(): Promise<DocsSuggestionRecord | null> {
    return null;
  }

  async resolveSuggestions(): Promise<readonly DocsSuggestionRecord[] | null> {
    return [];
  }

  async createAskHistoryItem(): Promise<DocsAskHistoryRecord> {
    return {
      id: "99999999-9999-4999-8999-999999999999",
      orgId,
      documentId: docId,
      actorId: actor.id,
      question: "Question?",
      answer: "Answer.",
      sourceScope: "document",
      sourceExcerpt: "Excerpt",
      metadata: {},
      createdAt: now,
      updatedAt: now,
    };
  }

  async listAskHistory(): Promise<readonly DocsAskHistoryRecord[]> {
    return [];
  }

  async clearAskHistory(): Promise<number> {
    return 0;
  }

  async getDocumentForActor(input: {
    readonly documentId: string;
  }): Promise<DocsDocumentRecord | null> {
    this.accessChecks.push(input.documentId);
    return this.optionsInput.accessible === false ? null : documentRecord();
  }

  async getDocsExportDocument(): Promise<DocsExportDocument | null> {
    return { id: docId, title: "Initial title", markdown: "# Initial title\n" };
  }

  async appendUpdate(input: Parameters<DocsStore["appendUpdate"]>[0]): Promise<DocsUpdateRecord> {
    this.#seq += 1;
    this.updates.push({
      actorId: input.actorId,
      documentId: input.documentId,
      metadata: input.metadata ?? {},
      text: input.update.toString("utf8"),
    });
    return {
      id: "55555555-5555-4555-8555-555555555555",
      orgId: input.orgId,
      documentId: input.documentId,
      actorId: input.actorId,
      seq: this.#seq,
      update: input.update,
      metadata: input.metadata ?? {},
      createdAt: now,
    };
  }

  async compactDocument(
    input: Parameters<DocsStore["compactDocument"]>[0],
  ): Promise<DocsDocumentRecord | null> {
    this.compactions.push({
      documentId: input.documentId,
      stateVectorPersisted: input.stateVector !== null && input.stateVector !== undefined,
      text: markdownFromYState(input.state),
    });
    return documentRecord({ state: input.state, updateSeq: this.#seq });
  }
}

class RecordingMeteringClient implements MeteringClient {
  readonly records: Array<{
    readonly orgId: string;
    readonly event: MeteringEvent;
    readonly trace: TraceContext | undefined;
  }> = [];

  async emit(orgId: string, event: MeteringEvent, trace?: TraceContext): Promise<void> {
    this.records.push({ orgId, event, trace });
  }

  async emitBatch(inputs: readonly MeteringEmitInput[]): Promise<void> {
    for (const input of inputs) {
      await this.emit(input.orgId, input.event, input.trace);
    }
  }
}

function documentRecord(
  overrides: {
    readonly state?: Buffer | null;
    readonly updateSeq?: number;
    readonly editorEngine?: string;
  } = {},
): DocsDocumentRecord {
  return {
    id: docId,
    orgId,
    title: "Initial title",
    threadId: null,
    ownerActorId: actor.id,
    createdByActorId: actor.id,
    ydocState: overrides.state ?? Buffer.from("# Initial title\n", "utf8"),
    ydocStateVector: null,
    updateSeq: overrides.updateSeq ?? 4,
    editorEngine: overrides.editorEngine ?? "legacy-yjs",
    formatVersion: 1,
    metadata: {},
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

function syncStep1Message(doc: Y.Doc): Buffer {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeSyncStep1(encoder, doc);
  return Buffer.from(encoding.toUint8Array(encoder));
}

function syncUpdateMessage(update: Uint8Array): Buffer {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeUpdate(encoder, update);
  return Buffer.from(encoding.toUint8Array(encoder));
}

function applySyncMessage(doc: Y.Doc, message: Buffer): void {
  const decoder = decoding.createDecoder(message);
  expect(decoding.readVarUint(decoder)).toBe(0);
  const encoder = encoding.createEncoder();
  syncProtocol.readSyncMessage(decoder, encoder, doc, "test");
}

function markdownFromYState(state: Buffer): string {
  try {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(state));
    return doc.getText("markdown").toJSON();
  } catch {
    return state.toString("utf8");
  }
}
