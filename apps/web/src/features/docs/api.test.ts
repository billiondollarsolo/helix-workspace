import { describe, expect, it, vi } from "vitest";
import {
  createDocsComment,
  createDocsDocument,
  createDocsSuggestion,
  createDocsSyncClient,
  exportDocsDocument,
  getDocsDocument,
  listDocsDocuments,
  listDocsSuggestions,
  resolveDocsSuggestion,
} from "./api";

const docId = "33333333-3333-4333-8333-333333333333";

describe("docs API", () => {
  it("creates Docs documents through the docs.create tool", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: docId,
          title: "Backend doc",
          threadId: "44444444-4444-4444-8444-444444444444",
          ownerActorId: "11111111-1111-4111-8111-111111111111",
          createdByActorId: "11111111-1111-4111-8111-111111111111",
          ydocState: btoa("# Backend doc\n"),
          ydocStateVector: null,
          updateSeq: 0,
          metadata: {},
          deletedAt: null,
          createdAt: "2026-05-20T12:00:00.000Z",
          updatedAt: "2026-05-20T12:00:00.000Z",
        }),
      ),
    );

    await expect(
      createDocsDocument({ title: "Backend doc", initialMarkdown: "# Backend doc\n" }, fetchImpl),
    ).resolves.toMatchObject({ id: docId, title: "Backend doc" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Backend doc",
        initialMarkdown: "# Backend doc\n",
        folderId: null,
        metadata: {},
      }),
    });
  });

  it("serializes folderId when creating Docs documents", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: docId,
          title: "Folder doc",
          threadId: "44444444-4444-4444-8444-444444444444",
          ownerActorId: "11111111-1111-4111-8111-111111111111",
          createdByActorId: "11111111-1111-4111-8111-111111111111",
          ydocState: btoa("# Folder doc\n"),
          ydocStateVector: null,
          updateSeq: 0,
          metadata: {},
          deletedAt: null,
          createdAt: "2026-05-20T12:00:00.000Z",
          updatedAt: "2026-05-20T12:00:00.000Z",
        }),
      ),
    );

    await createDocsDocument(
      {
        title: "Folder doc",
        initialMarkdown: "# Folder doc\n",
        folderId: "44444444-4444-4444-8444-444444444444",
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Folder doc",
        initialMarkdown: "# Folder doc\n",
        folderId: "44444444-4444-4444-8444-444444444444",
        metadata: {},
      }),
    });
  });

  it("lists readable Docs documents through docs.list", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          documents: [
            {
              id: docId,
              title: "Backend doc",
              threadId: "44444444-4444-4444-8444-444444444444",
              ownerActorId: "11111111-1111-4111-8111-111111111111",
              createdByActorId: "11111111-1111-4111-8111-111111111111",
              ydocState: btoa("# Backend doc\n"),
              ydocStateVector: null,
              updateSeq: 0,
              metadata: {},
              deletedAt: null,
              createdAt: "2026-05-20T12:00:00.000Z",
              updatedAt: "2026-05-20T12:00:00.000Z",
            },
          ],
        }),
      ),
    );

    await expect(listDocsDocuments({ query: "backend", limit: 10 }, fetchImpl)).resolves.toEqual([
      expect.objectContaining({ id: docId, title: "Backend doc" }),
    ]);
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "backend", limit: 10 }),
    });
  });

  it("hydrates selected document content through docs.export", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          docId,
          format: "markdown",
          filename: "backend-doc.markdown",
          mimeType: "text/markdown; charset=utf-8",
          byteSize: 32,
          contentBase64: btoa("# Backend doc\n\nLive content\n"),
          text: "# Backend doc\n\nLive content\n",
          metadata: {},
        }),
      ),
    );

    await expect(exportDocsDocument({ docId }, fetchImpl)).resolves.toMatchObject({
      docId,
      text: "# Backend doc\n\nLive content\n",
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId, format: "markdown", includeComments: false }),
    });
  });

  it("serializes comment-inclusive Docs export options", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          docId,
          format: "markdown",
          filename: "backend-doc.markdown",
          mimeType: "text/markdown; charset=utf-8",
          byteSize: 32,
          contentBase64: btoa("# Backend doc\n\nLive content\n"),
          text: "# Backend doc\n\nLive content\n",
          metadata: {},
        }),
      ),
    );

    await exportDocsDocument(
      {
        docId,
        format: "markdown",
        includeComments: true,
        filename: "review-copy.markdown",
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docId,
        format: "markdown",
        includeComments: true,
        filename: "review-copy.markdown",
      }),
    });
  });

  it("gets readable Docs documents through docs.get", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: docId,
          title: "Backend doc",
          threadId: "44444444-4444-4444-8444-444444444444",
          ownerActorId: "11111111-1111-4111-8111-111111111111",
          createdByActorId: "11111111-1111-4111-8111-111111111111",
          ydocState: btoa("# Backend doc\n"),
          ydocStateVector: null,
          updateSeq: 0,
          metadata: {},
          deletedAt: null,
          createdAt: "2026-05-20T12:00:00.000Z",
          updatedAt: "2026-05-20T12:00:00.000Z",
        }),
      ),
    );

    await expect(getDocsDocument({ docId }, fetchImpl)).resolves.toMatchObject({
      id: docId,
      title: "Backend doc",
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId }),
    });
  });

  it("creates Docs comments with structured anchors", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: "55555555-5555-4555-8555-555555555555",
          documentId: docId,
          actorId: "11111111-1111-4111-8111-111111111111",
          anchor: { label: "Open risks" },
          body: "Needs owner",
          status: "open",
          metadata: {},
          resolvedAt: null,
          createdAt: "2026-05-20T12:05:00.000Z",
          updatedAt: null,
        }),
      ),
    );

    await createDocsComment(
      { docId, body: "Needs owner", anchor: { label: "Open risks" } },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.comment.create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docId,
        body: "Needs owner",
        anchor: { label: "Open risks" },
        metadata: {},
      }),
    });
  });

  it("creates Docs suggestions as tracked changes through docs.suggestion.create", async () => {
    const suggestionId = "77777777-7777-4777-8777-777777777777";
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: suggestionId,
          documentId: docId,
          actorId: "11111111-1111-4111-8111-111111111111",
          anchor: { label: "Open risks" },
          beforeText: "teh plan",
          afterText: "the plan",
          reason: "typo",
          status: "pending",
          metadata: {},
          resolvedByActorId: null,
          resolvedAt: null,
          createdAt: "2026-05-21T12:00:00.000Z",
          updatedAt: null,
        }),
      ),
    );

    await expect(
      createDocsSuggestion(
        {
          docId,
          beforeText: "teh plan",
          afterText: "the plan",
          reason: "typo",
          anchor: { label: "Open risks" },
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({ id: suggestionId, status: "pending", beforeText: "teh plan" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.suggestion.create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docId,
        beforeText: "teh plan",
        afterText: "the plan",
        reason: "typo",
        anchor: { label: "Open risks" },
        metadata: {},
      }),
    });
  });

  it("lists pending Docs suggestions through docs.suggestion.list", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ suggestions: [] })),
    );

    await expect(listDocsSuggestions({ docId, status: "pending" }, fetchImpl)).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.suggestion.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId, status: "pending" }),
    });
  });

  it("resolves Docs suggestions through docs.suggestion.resolve", async () => {
    const suggestionId = "77777777-7777-4777-8777-777777777777";
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: suggestionId,
          documentId: docId,
          actorId: null,
          anchor: {},
          beforeText: "teh plan",
          afterText: "the plan",
          reason: "typo",
          status: "accepted",
          metadata: {},
          resolvedByActorId: "11111111-1111-4111-8111-111111111111",
          resolvedAt: "2026-05-21T12:05:00.000Z",
          createdAt: "2026-05-21T12:00:00.000Z",
          updatedAt: "2026-05-21T12:05:00.000Z",
        }),
      ),
    );

    await expect(
      resolveDocsSuggestion({ suggestionId, status: "accepted" }, fetchImpl),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.suggestion.resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ suggestionId, status: "accepted" }),
    });
  });

  it("surfaces backend tool errors", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ error: "missing docs scope" }, { status: 403 })),
    );

    await expect(createDocsDocument({ title: "Backend doc" }, fetchImpl)).rejects.toThrow(
      "missing docs scope",
    );
  });

  it("serializes Docs sync websocket updates and parses events", () => {
    const events: unknown[] = [];
    const client = createDocsSyncClient({
      docId,
      url: `ws://localhost/sync/docs/${docId}`,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onEvent: (event) => events.push(event),
    });
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) {
      throw new Error("Expected websocket instance.");
    }

    client.sendUpdate({
      updateBase64: btoa("# Backend doc\n\nEdited body\n"),
      stateBase64: btoa("# Backend doc\n\nEdited body\n"),
      metadata: { source: "web.docs-shell" },
    });
    expect(socket.sent.map((payload) => JSON.parse(payload) as unknown)).toEqual([
      {
        type: "update",
        updateBase64: btoa("# Backend doc\n\nEdited body\n"),
        stateBase64: btoa("# Backend doc\n\nEdited body\n"),
        metadata: { source: "web.docs-shell" },
      },
    ]);

    socket.receive({
      type: "ready",
      documentId: docId,
      updateSeq: 2,
      stateBase64: btoa("# Synced doc\n"),
    });
    expect(events).toEqual([
      { type: "ready", documentId: docId, updateSeq: 2, stateBase64: btoa("# Synced doc\n") },
    ]);
  });
});

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Set<(event: { readonly data?: string }) => void>>();
  readyState = FakeWebSocket.OPEN;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { readonly data?: string }) => void): void {
    const listeners =
      this.#listeners.get(type) ?? new Set<(event: { readonly data?: string }) => void>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  receive(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  private emit(type: string, event: { readonly data?: string }): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }
}
