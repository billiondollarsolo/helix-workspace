// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preloadDocsRouteData, validateDocsRouteSearch } from "@/routes/_shell/docs";
import { DocsShell } from "./docs-shell";
import type { DocsExportResult } from "./api";
import { docsQueryKeys } from "./queries";

vi.mock("@helix/sdk-web", () => ({
  SuggestionSlot: ({ emptyFallback }: { readonly emptyFallback?: React.ReactNode }) =>
    emptyFallback ?? null,
}));

const blockerHarness = vi.hoisted(() => {
  const state: Record<string, unknown> = {
    status: "idle",
    current: undefined,
    next: undefined,
    action: undefined,
    proceed: undefined,
    reset: undefined,
  };
  return {
    state,
    useBlocker: vi.fn(),
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useBlocker: blockerHarness.useBlocker,
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const docId = "33333333-3333-4333-8333-333333333333";
const initialDocId = "66666666-6666-4666-8666-666666666666";

describe("DocsShell backend tool integration", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    blockerHarness.state = {
      status: "idle",
      current: undefined,
      next: undefined,
      action: undefined,
      proceed: undefined,
      reset: undefined,
    };
    blockerHarness.useBlocker.mockReset();
    blockerHarness.useBlocker.mockImplementation(() => blockerHarness.state);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: 0,
        },
      },
    });
    fetchMock = vi.fn<typeof fetch>((input, init) => {
      if (input === "/api/tools/docs.create") {
        return Promise.resolve(
          Response.json({
            id: docId,
            title: "Untitled document",
            threadId: "44444444-4444-4444-8444-444444444444",
            ownerActorId: "11111111-1111-4111-8111-111111111111",
            createdByActorId: "11111111-1111-4111-8111-111111111111",
            ydocState: btoa("# Untitled document\n"),
            ydocStateVector: null,
            updateSeq: 0,
            metadata: {},
            deletedAt: null,
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:00:00.000Z",
          }),
        );
      }
      if (input === "/api/tools/docs.list") {
        return Promise.resolve(Response.json({ documents: [] }));
      }
      if (input === "/api/tools/docs.export") {
        const requestDocId = docIdFromInit(init) ?? docId;
        return Promise.resolve(
          Response.json({
            docId: requestDocId,
            format: "markdown",
            filename: "untitled-document.markdown",
            mimeType: "text/markdown; charset=utf-8",
            byteSize: 48,
            contentBase64: btoa("# Backend hydrated title\n\nBackend hydrated body\n"),
            text: "# Backend hydrated title\n\nBackend hydrated body\n",
            metadata: {},
          }),
        );
      }
      if (input === "/api/tools/docs.comment.create") {
        return Promise.resolve(
          Response.json({
            id: "55555555-5555-4555-8555-555555555555",
            documentId: docIdFromInit(init) ?? docId,
            actorId: "11111111-1111-4111-8111-111111111111",
            anchor: {},
            body: "",
            status: "open",
            metadata: {},
            resolvedAt: null,
            createdAt: "2026-05-20T12:01:00.000Z",
            updatedAt: null,
          }),
        );
      }
      return Promise.resolve(Response.json({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders backend Docs documents from docs.list", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (input === "/api/tools/docs.list") {
        return Promise.resolve(
          Response.json({
            documents: [
              {
                id: initialDocId,
                title: "Backend listed doc",
                threadId: "44444444-4444-4444-8444-444444444444",
                ownerActorId: "11111111-1111-4111-8111-111111111111",
                createdByActorId: "11111111-1111-4111-8111-111111111111",
                ydocState: btoa("# Backend listed doc\n\nBackend listed body\n"),
                ydocStateVector: null,
                updateSeq: 0,
                metadata: {},
                deletedAt: null,
                createdAt: "2026-05-20T12:00:00.000Z",
                updatedAt: "2026-05-20T12:00:00.000Z",
              },
            ],
          }),
        );
      }
      if (input === "/api/tools/docs.export") {
        return Promise.resolve(
          Response.json({
            docId: docIdFromInit(init) ?? initialDocId,
            format: "markdown",
            filename: "backend-listed-doc.markdown",
            mimeType: "text/markdown; charset=utf-8",
            byteSize: 48,
            contentBase64: btoa("# Backend listed doc\n\nBackend listed body\n"),
            text: "# Backend listed doc\n\nBackend listed body\n",
            metadata: {},
          }),
        );
      }
      return Promise.resolve(Response.json({ ok: true }));
    });

    renderDocs();

    await waitForText("Backend listed doc");
    await waitForText("Backend listed body");

    const listCall = fetchMock.mock.calls.find((call) => call[0] === "/api/tools/docs.list");
    expect(jsonBody(listCall)).toMatchObject({ limit: 100 });
    expect(container.textContent).not.toContain("Q2 launch plan");
  });

  it("renders sample Docs documents when the backend is unavailable", async () => {
    fetchMock.mockImplementation((input) => {
      if (input === "/api/tools/docs.list") {
        return Promise.reject(new Error("offline"));
      }
      return Promise.resolve(Response.json({ ok: true }));
    });

    renderDocs();

    await waitForText("Docs backend unavailable");
    await waitForText("AI Services and Keys");
    await waitForText("Training Course Links");
  });

  it("creates and hydrates a backend Docs document", async () => {
    renderDocs();

    await clickButton("New doc");
    await waitForText("Backend hydrated title");
    await waitForText("Backend hydrated body");

    const createCall = fetchMock.mock.calls.find((call) => call[0] === "/api/tools/docs.create");
    const exportCall = fetchMock.mock.calls.find((call) => call[0] === "/api/tools/docs.export");
    expect(createCall?.[1]?.method).toBe("POST");
    expect(jsonBody(createCall)).toMatchObject({
      title: "Untitled document",
      metadata: { source: "web.docs-shell" },
    });
    expect(jsonBody(exportCall)).toMatchObject({
      docId,
      format: "markdown",
      includeComments: true,
    });
  });

  it("loads an initial document id through docs.export", async () => {
    expect(validateDocsRouteSearch({ doc: initialDocId })).toEqual({ doc: initialDocId });
    expect(validateDocsRouteSearch({ doc: " " })).toEqual({});

    await preloadDocsRouteData(queryClient, { doc: initialDocId });
    expect(queryClient.getQueryData(docsQueryKeys.documents({ limit: 100 }))).toEqual([]);
    const preloadedExport = queryClient.getQueryData<DocsExportResult>(
      docsQueryKeys.documentExport({ docId: initialDocId, includeComments: true }),
    );
    expect(preloadedExport?.text).toContain("Backend hydrated");

    fetchMock.mockClear();
    renderDocs({ initialDocumentId: initialDocId });

    await waitForText("Backend hydrated title");
    await waitForText("Backend hydrated body");

    const createCall = fetchMock.mock.calls.find((call) => call[0] === "/api/tools/docs.create");
    const exportCall = fetchMock.mock.calls.find((call) => call[0] === "/api/tools/docs.export");
    expect(createCall).toBeUndefined();
    expect(jsonBody(exportCall)).toMatchObject({
      docId: initialDocId,
      format: "markdown",
      includeComments: true,
    });
  });

  it("exports backend documents as Markdown with comments included", async () => {
    const createObjectUrl = vi.fn(() => "blob:docs-export");
    const revokeObjectUrl = vi.fn();
    const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectUrl },
      revokeObjectURL: { configurable: true, value: revokeObjectUrl },
    });

    renderDocs({ initialDocumentId: initialDocId });
    await waitForText("Backend hydrated title");
    fetchMock.mockClear();

    await clickButton("Export");
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => call[0] === "/api/tools/docs.export")).toBe(true),
    );

    const exportCall = fetchMock.mock.calls.find((call) => call[0] === "/api/tools/docs.export");
    expect(jsonBody(exportCall)).toMatchObject({
      docId: initialDocId,
      format: "markdown",
      includeComments: true,
    });
    expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:docs-export");
    if (originalCreateObjectUrl !== undefined) {
      Object.defineProperty(URL, "createObjectURL", originalCreateObjectUrl);
    }
    if (originalRevokeObjectUrl !== undefined) {
      Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectUrl);
    }
  });

  it("submits and resets the Docs comment form", async () => {
    renderDocs({ initialDocumentId: initialDocId });

    await waitForText("Backend hydrated title");
    await fillComment("Please confirm the export owner.");
    await clickButton("Comment");
    await waitForText("Please confirm the export owner.");

    const commentCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/tools/docs.comment.create",
    );
    expect(jsonBody(commentCall)).toMatchObject({
      docId: initialDocId,
      body: "Please confirm the export owner.",
      anchor: { label: "Backend hydrated title" },
      metadata: { source: "web.docs-shell" },
    });
    expect(commentTextarea().value).toBe("");
    expect(commentButton().disabled).toBe(true);
  });

  it("keeps blank Docs comments local to the form", async () => {
    renderDocs({ initialDocumentId: initialDocId });

    await waitForText("Backend hydrated title");
    await fillComment("   ");
    await submitCommentForm();

    expect(fetchMock.mock.calls.some((call) => call[0] === "/api/tools/docs.comment.create")).toBe(
      false,
    );
    expect(commentTextarea().value).toBe("   ");
    expect(commentButton().disabled).toBe(true);
  });

  it("arms TanStack Router blocking only while the Docs comment draft is unsaved", async () => {
    renderDocs({ initialDocumentId: initialDocId });

    await waitForText("Backend hydrated title");
    await waitFor(() =>
      expect(lastBlockerOptions()).toMatchObject({
        disabled: true,
        enableBeforeUnload: false,
        withResolver: true,
      }),
    );

    await fillComment("Hold this before leaving.");
    await waitFor(() => expect(lastBlockerOptions()).toMatchObject({ disabled: false }));
    expect(await lastBlockerOptions().shouldBlockFn()).toBe(true);

    await clickButton("Comment");
    await waitFor(() => expect(lastBlockerOptions()).toMatchObject({ disabled: true }));
  });

  it("shows the unsaved draft blocker dialog and supports stay or leave", async () => {
    const proceed = vi.fn();
    const reset = vi.fn();
    renderDocs({ initialDocumentId: initialDocId });

    await waitForText("Backend hydrated title");
    await fillComment("Do not lose this.");
    blockerHarness.state = {
      status: "blocked",
      current: undefined,
      next: undefined,
      action: undefined,
      proceed,
      reset,
    };
    renderDocs({ initialDocumentId: initialDocId });

    await waitFor(() => expect(document.body.textContent).toContain("Discard unsaved comment?"));
    await clickDialogButton("Stay");
    expect(reset).toHaveBeenCalledOnce();

    await clickDialogButton("Leave");
    expect(proceed).toHaveBeenCalledOnce();
  });

  it("syncs backend Docs documents through the websocket route", async () => {
    const sockets: FakeWebSocket[] = [];
    vi.stubGlobal("WebSocket", fakeWebSocketClass(sockets));
    renderDocs({ initialDocumentId: initialDocId });

    await waitForText("Backend hydrated title");
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = firstSocket(sockets);
    openSocket(socket);
    receiveSocket(socket, {
      type: "update",
      documentId: initialDocId,
      actorId: "11111111-1111-4111-8111-111111111111",
      seq: 2,
      updateBase64: btoa("# Remote synced title\n\nRemote synced paragraph\n"),
      createdAt: "2026-05-20T12:02:00.000Z",
    });

    await waitForText("Remote synced title");
    await editBlock("Remote synced paragraph", "Local synced paragraph");
    await waitFor(() => {
      const sentPayloads = socket.sent.map(
        (payload) => JSON.parse(payload) as Record<string, unknown>,
      );
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({
          type: "update",
          metadata: { source: "web.docs-shell" },
        }),
      );
      expect(sentPayloads.at(-1)?.updateBase64).toEqual(expect.any(String));
      expect(sentPayloads.at(-1)?.stateBase64).toEqual(expect.any(String));
    });
  });

  it("captures editor changes as suggestions when suggesting mode is on", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (input === "/api/tools/docs.export") {
        return Promise.resolve(
          Response.json({
            docId: docIdFromInit(init) ?? initialDocId,
            format: "markdown",
            filename: "backend-listed-doc.markdown",
            mimeType: "text/markdown; charset=utf-8",
            byteSize: 48,
            contentBase64: btoa("# Backend hydrated title\n\nBackend hydrated body\n"),
            text: "# Backend hydrated title\n\nBackend hydrated body\n",
            metadata: {},
          }),
        );
      }
      if (input === "/api/tools/docs.suggestion.create") {
        return Promise.resolve(
          Response.json({
            id: "88888888-8888-4888-8888-888888888888",
            documentId: docIdFromInit(init) ?? initialDocId,
            actorId: "11111111-1111-4111-8111-111111111111",
            anchor: { label: "Backend hydrated title" },
            beforeText: "Backend hydrated body",
            afterText: "Backend reviewed body",
            reason: "Proposed edit",
            status: "pending",
            metadata: {},
            resolvedByActorId: null,
            resolvedAt: null,
            createdAt: "2026-05-21T12:00:00.000Z",
            updatedAt: null,
          }),
        );
      }
      return Promise.resolve(Response.json({ ok: true }));
    });

    renderDocs({ initialDocumentId: initialDocId });
    await waitForText("Backend hydrated title");
    fetchMock.mockClear();

    await clickButton("Editing");
    await waitForText("Suggesting mode");

    await editBlock("Backend hydrated body", "Backend reviewed body");

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => call[0] === "/api/tools/docs.suggestion.create"),
      ).toBe(true),
    );
    const suggestionCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/tools/docs.suggestion.create",
    );
    expect(jsonBody(suggestionCall)).toMatchObject({
      docId: initialDocId,
      beforeText: "Backend hydrated body",
      afterText: "Backend reviewed body",
    });
  });

  it("falls back to local Docs data when backend create fails", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    renderDocs();

    await clickButton("New doc");
    await waitForText("Untitled document");
    await waitForText("Offline");
    await waitForText("Offline/local");
  });

  function renderDocs(props: React.ComponentProps<typeof DocsShell> = {}) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <DocsShell {...props} />
        </QueryClientProvider>,
      );
    });
  }

  async function clickButton(text: string) {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes(text),
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Button not found: ${text}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function clickDialogButton(text: string) {
    const button = Array.from(document.body.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes(text),
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Dialog button not found: ${text}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function fillComment(value: string) {
    const textarea = commentTextarea();
    setInputValue(textarea, value);
    act(() => {
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function submitCommentForm() {
    const form = container.querySelector("form.docs-comment-form");
    if (!(form instanceof HTMLFormElement)) {
      throw new Error("Comment form not found");
    }
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function editBlock(currentText: string, nextText: string) {
    const block = Array.from(
      container.querySelectorAll('[role="textbox"], .ProseMirror h1, .ProseMirror p'),
    ).find((candidate) => candidate.textContent === currentText);
    if (!(block instanceof HTMLElement)) {
      throw new Error(`Editable block not found: ${currentText}`);
    }
    const eventTarget = block.closest(".docs-document-surface") ?? block;
    act(() => {
      block.textContent = nextText;
      eventTarget.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextText }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  function commentTextarea() {
    const textarea = container.querySelector(".docs-comment-form textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("Comment textarea not found");
    }
    return textarea;
  }

  function commentButton() {
    const button = Array.from(container.querySelectorAll(".docs-comment-form button")).find(
      (candidate) => candidate.textContent?.includes("Comment"),
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("Comment button not found");
    }
    return button;
  }

  async function waitForText(text: string) {
    await waitFor(() => expect(container.textContent).toContain(text));
  }

  function openSocket(socket: FakeWebSocket) {
    act(() => {
      socket.open();
    });
  }

  function receiveSocket(socket: FakeWebSocket, payload: unknown) {
    act(() => {
      socket.receive(payload);
    });
  }

  function firstSocket(sockets: readonly FakeWebSocket[]): FakeWebSocket {
    const socket = sockets[0];
    if (socket === undefined) {
      throw new Error("Expected websocket instance.");
    }
    return socket;
  }

  async function waitFor(assertion: () => void | Promise<void>) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await act(async () => {
          await Promise.resolve();
        });
        await assertion();
        return;
      } catch (error) {
        lastError = error;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
    }
    throw lastError;
  }

  function lastBlockerOptions() {
    const call = blockerHarness.useBlocker.mock.calls.at(-1);
    if (call === undefined) {
      throw new Error("useBlocker was not called.");
    }
    return call[0] as {
      readonly disabled: boolean;
      readonly enableBeforeUnload: boolean;
      readonly withResolver: true;
      readonly shouldBlockFn: () => boolean | Promise<boolean>;
    };
  }
});

function setInputValue(input: HTMLTextAreaElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  descriptor?.set?.call(input, value);
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Set<(event: { readonly data?: string }) => void>>();
  readyState = FakeWebSocket.CONNECTING;

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

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
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

function fakeWebSocketClass(instances: FakeWebSocket[]): typeof WebSocket {
  return class extends FakeWebSocket {
    constructor() {
      super();
      instances.push(this);
    }
  } as unknown as typeof WebSocket;
}

function jsonBody(call: readonly unknown[] | undefined): unknown {
  const init = call?.[1];
  if (typeof init !== "object" || init === null || !("body" in init)) {
    return undefined;
  }
  const body = (init as RequestInit).body;
  if (typeof body !== "string") {
    return undefined;
  }
  return JSON.parse(body);
}

function docIdFromInit(init: RequestInit | undefined): string | undefined {
  const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  return isRecord(body) && typeof body.docId === "string" ? body.docId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
