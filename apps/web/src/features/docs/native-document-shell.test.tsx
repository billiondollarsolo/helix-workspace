// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WebPlatformProvider, createWebPlatformHost, type WebPlatformHost } from "@helix/sdk-web";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  NATIVE_DOCUMENT_SELECT_ANCHOR_EVENT,
  type NativeDocumentAnchorSelectionDetail,
  type NativeDocumentSelectionAnchor,
} from "./native-document-anchors";
import {
  NativeDocumentShell,
  nativeDocumentAnchorDecorationsFromRecords,
  nativeDocumentEditorInstanceKey,
} from "./native-document-shell";

vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({
    status: "idle",
    current: undefined,
    next: undefined,
    action: undefined,
    proceed: undefined,
    reset: undefined,
  }),
  Link: ({
    children,
    to,
    className,
  }: {
    readonly children: ReactNode;
    readonly to: string;
    readonly className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("NativeDocumentShell", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let platformHost: WebPlatformHost;
  let localStorageStore: Map<string, string>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    localStorageStore = new Map();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => localStorageStore.get(key) ?? null,
        setItem(key: string, value: string) {
          localStorageStore.set(key, value);
        },
        removeItem(key: string) {
          localStorageStore.delete(key);
        },
      },
    });
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    platformHost = createWebPlatformHost({
      queryClient,
      getColorMode: () => "system",
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    queryClient.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the native document session returned by the editors API", async () => {
    const print = vi.fn();
    const createObjectUrl = vi.fn(() => "blob:doc-export");
    const revokeObjectUrl = vi.fn();
    const clipboardWriteText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue();
    let fullscreenElement: Element | null = null;
    const requestFullscreen = vi.fn(() => {
      fullscreenElement = document.documentElement;
      return Promise.resolve();
    });
    const exitFullscreen = vi.fn(() => {
      fullscreenElement = null;
      return Promise.resolve();
    });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    Object.defineProperty(window, "print", { configurable: true, value: print });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement,
    });
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: exitFullscreen,
    });
    const askHistory: unknown[] = [];
    const stateBase64 = nativeStateBase64({
      heading: "Session heading",
      paragraph: "Session body paragraph",
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "/api/auth/get-session") {
        return Promise.resolve(
          Response.json({
            user: {
              id: "session-user",
              email: "ada@helix.local",
              name: "Ada Lovelace",
              actorId: "actor-1",
            },
          }),
        );
      }
      if (url === "/api/tools/docs.create") {
        return Promise.resolve(
          Response.json({
            id: "doc-created-from-menu",
            orgId: "org-1",
            title: "Untitled document",
            threadId: null,
            ownerActorId: "actor-1",
            createdByActorId: "actor-1",
            ydocState: null,
            ydocStateVector: null,
            updateSeq: 0,
            editorEngine: "helix-native-document",
            formatVersion: 1,
            metadata: { createdFrom: "web.native-document-shell" },
            deletedAt: null,
            createdAt: "2026-05-23T12:00:00.000Z",
            updatedAt: "2026-05-23T12:00:00.000Z",
          }),
        );
      }
      if (url === "/api/tools/docs.copy") {
        return Promise.resolve(
          Response.json({
            id: "doc-copied-from-menu",
            orgId: "org-1",
            title: "Native session doc (Copy)",
            threadId: null,
            ownerActorId: "actor-1",
            createdByActorId: "actor-1",
            ydocState: stateBase64,
            ydocStateVector: null,
            updateSeq: 0,
            editorEngine: "helix-native-document",
            formatVersion: 1,
            metadata: {
              createdFrom: "web.native-document-shell.make-copy",
              copiedFromDocumentId: "doc-1",
            },
            deletedAt: null,
            createdAt: "2026-05-23T12:00:00.000Z",
            updatedAt: "2026-05-23T12:00:00.000Z",
          }),
        );
      }
      if (url === "/api/tools/drive.trash") {
        return Promise.resolve(
          Response.json({
            id: "doc-1",
            name: "Native session doc",
            app: "docs",
            mimeType: "application/vnd.helix.document",
            size: 96,
            updatedAt: "2026-05-23T12:05:00.000Z",
            createdAt: "2026-05-23T12:00:00.000Z",
            metadata: {},
            deletedAt: "2026-05-23T12:06:00.000Z",
          }),
        );
      }
      if (url === "/api/tools/drive.access.list") {
        return Promise.resolve(
          Response.json({
            grants: [
              {
                actorId: "actor-2",
                role: "reader",
                displayName: "Maya Chen",
                email: "maya@helix.local",
                grantedByActorId: "actor-1",
                expiresAt: null,
                createdAt: "2026-05-23T12:02:00.000Z",
                updatedAt: "2026-05-23T12:02:00.000Z",
              },
            ],
          }),
        );
      }
      if (url === "/api/tools/docs.export") {
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const format = (body as { readonly format?: string }).format ?? "docx";
        return Promise.resolve(
          Response.json({
            docId: "doc-1",
            format,
            filename: `native-session-doc.${format}`,
            mimeType:
              format === "pdf"
                ? "application/pdf"
                : format === "epub"
                  ? "application/epub+zip"
                  : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            byteSize: 8,
            contentBase64: btoa("exported"),
            metadata: {},
          }),
        );
      }
      if (url === "/api/tools/docs.update-title") {
        return Promise.resolve(
          Response.json({
            id: "doc-1",
            orgId: "org-1",
            title: "Renamed session doc",
            threadId: null,
            ownerActorId: "actor-1",
            createdByActorId: "actor-1",
            ydocState: null,
            ydocStateVector: null,
            updateSeq: 4,
            editorEngine: "helix-native-document",
            formatVersion: 1,
            metadata: {},
            deletedAt: null,
            createdAt: "2026-05-23T12:00:00.000Z",
            updatedAt: "2026-05-23T12:04:00.000Z",
          }),
        );
      }
      if (url === "/api/tools/docs.update-layout") {
        return Promise.resolve(
          Response.json({
            id: "doc-1",
            orgId: "org-1",
            title: "Native session doc",
            threadId: null,
            ownerActorId: "actor-1",
            createdByActorId: "actor-1",
            ydocState: null,
            ydocStateVector: null,
            updateSeq: 4,
            editorEngine: "helix-native-document",
            formatVersion: 1,
            metadata: {
              nativeDocumentLayout: {
                layoutMode: "page",
                columnCount: 1,
                sections: [
                  {
                    id: "default",
                    title: "Document",
                    layoutMode: "page",
                    columnCount: 1,
                    pageSize: "a4",
                    orientation: "landscape",
                  },
                ],
              },
            },
            deletedAt: null,
            createdAt: "2026-05-23T12:00:00.000Z",
            updatedAt: "2026-05-23T12:05:00.000Z",
          }),
        );
      }
      if (url === "/api/tools/docs.comment.list") {
        return Promise.resolve(
          Response.json({
            comments: [
              {
                id: "comment-1",
                documentId: "doc-1",
                actorId: "actor-1",
                author: { id: "actor-1", displayName: "Ada" },
                anchor: { kind: "native-document" },
                body: "Review this section",
                status: "open",
                metadata: {},
                resolvedAt: null,
                createdAt: "2026-05-23T12:01:00.000Z",
                updatedAt: "2026-05-23T12:01:00.000Z",
              },
            ],
          }),
        );
      }
      if (url === "/api/tools/docs.suggestion.list") {
        return Promise.resolve(
          Response.json({
            suggestions: [
              {
                id: "suggestion-1",
                documentId: "doc-1",
                actorId: "actor-1",
                anchor: { kind: "native-document" },
                beforeText: "teh heading",
                afterText: "the heading",
                reason: "Typo",
                status: "pending",
                metadata: {},
                resolvedByActorId: null,
                resolvedAt: null,
                createdAt: "2026-05-23T12:02:00.000Z",
                updatedAt: "2026-05-23T12:02:00.000Z",
              },
            ],
          }),
        );
      }
      if (url === "/api/tools/docs.ask.history.list") {
        return Promise.resolve(
          Response.json({
            history: askHistory,
          }),
        );
      }
      if (url === "/api/tools/docs.ask.answer") {
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const historyItem = {
          id: "ask-1",
          documentId: "doc-1",
          actorId: "actor-1",
          question: (body as { readonly question?: string }).question ?? "",
          answer: "The session is about readiness and export risks.",
          sourceScope: "document",
          sourceExcerpt: "Session heading Session body paragraph",
          metadata: {
            providerId: "test-ai",
            model: "test-model",
            citations: (body as { readonly citations?: unknown }).citations ?? [],
          },
          createdAt: "2026-05-23T12:04:00.000Z",
          updatedAt: "2026-05-23T12:04:00.000Z",
        };
        askHistory.unshift(historyItem);
        return Promise.resolve(Response.json(historyItem));
      }
      if (url === "/api/tools/docs.version.list") {
        return Promise.resolve(
          Response.json({
            versions: [
              {
                id: "version-1",
                documentId: "doc-1",
                actorId: "actor-1",
                seq: 4,
                byteSize: 96,
                metadata: { source: "web.native-document.editor" },
                createdAt: "2026-05-23T12:03:00.000Z",
              },
            ],
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          editor: "document",
          engine: "helix-native-document",
          formatVersion: 1,
          resource: {
            orgId: "org-1",
            resourceId: "doc-1",
            kind: "document",
          },
          document: {
            id: "doc-1",
            orgId: "org-1",
            title: "Native session doc",
            ownerActorId: "actor-1",
            editorEngine: "helix-native-document",
            formatVersion: 1,
            updateSeq: 4,
            stateBase64,
            stateVectorBase64: "BAUG",
            layoutSettings: {
              layoutMode: "pageless",
              columnCount: 2,
              sections: [
                {
                  id: "default",
                  title: "Document",
                  layoutMode: "pageless",
                  columnCount: 2,
                  pageSize: "a4",
                  orientation: "landscape",
                },
              ],
            },
            updatedAt: "2026-05-23T12:00:00.000Z",
          },
          shellRoute: "/docs/:id",
          apiRoute: "/api/editors/documents/:documentId",
          sync: {
            protocol: "yjs",
            route: "/sync/docs/:docId",
            url: "/sync/docs/doc-1?protocol=yjs",
            awareness: true,
          },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render("doc-1");
    await settle();

    expect(container.textContent ?? "").toContain("Native session doc");
    expect(container.querySelector('[role="status"][aria-label="Connected"]')).not.toBeNull();
    clickAppMenu("file");
    await settle();
    clickOpenMenuItem("New document");
    await settle();
    expect(fetchMock).toHaveBeenCalledWith("/api/tools/docs.create", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Untitled document",
        initialMarkdown: "",
        editorEngine: "helix-native-document",
        formatVersion: 1,
        folderId: null,
        metadata: { createdFrom: "web.native-document-shell" },
      }),
    });
    clickAppMenu("file");
    await settle();
    clickOpenMenuItem("Make a copy");
    await settle();
    expect(fetchMock).toHaveBeenCalledWith("/api/tools/docs.copy", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docId: "doc-1",
        title: "Native session doc (Copy)",
        metadata: {
          createdFrom: "web.native-document-shell.make-copy",
        },
      }),
    });
    clickAppMenu("file");
    await settle();
    clickOpenMenuItem("Move to trash");
    await settle();
    expect(fetchMock).toHaveBeenCalledWith("/api/tools/drive.trash", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objectId: "doc-1" }),
    });
    clickAppMenu("view");
    await settle();
    clickOpenMenuItem("Show outline");
    await settle();
    expect(container.textContent ?? "").toContain("Session heading");
    expect(container.textContent ?? "").toContain("Words");
    expect(container.querySelector('[data-native-document-rulers="true"]')).not.toBeNull();
    clickAppMenu("view");
    await settle();
    clickOpenMenuItem("Hide ruler");
    await settle();
    expect(container.querySelector('[data-native-document-rulers="true"]')).toBeNull();
    expect(localStorageStore.get("helix.docs.showRulers")).toBe("false");
    clickAppMenu("view");
    await settle();
    clickOpenMenuItem("Show ruler");
    await settle();
    expect(container.querySelector('[data-native-document-rulers="true"]')).not.toBeNull();
    expect(localStorageStore.get("helix.docs.showRulers")).toBe("true");
    clickAppMenu("view");
    await settle();
    clickOpenMenuItem("Full screen");
    await settle();
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    clickAppMenu("view");
    await settle();
    clickOpenMenuItem("Full screen");
    await settle();
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    clickTab("Comments");
    await settle();
    expect(container.textContent ?? "").toContain("Ada");
    clickAppMenu("tools");
    await settle();
    clickOpenMenuItem("Word count");
    await settle();
    expect(sidePanelTab("Outline")?.getAttribute("aria-selected")).toBe("true");
    expect(container.textContent ?? "").toContain("5");
    clickAppMenu("share");
    await settle();
    clickOpenMenuItem("Copy link");
    await settle();
    expect(clipboardWriteText).toHaveBeenCalledWith(window.location.href);
    clickAppMenu("help");
    await settle();
    clickOpenMenuItem("Keyboard shortcuts");
    await settle();
    expect(
      container.querySelector('[role="dialog"][aria-label="Keyboard shortcuts"]'),
    ).not.toBeNull();
    expect(container.textContent ?? "").toContain("Find in document");
    act(() => {
      buttonWithText("Close")?.click();
    });
    await settle();
    clickAppMenu("help");
    await settle();
    clickOpenMenuItem("About Helix Docs");
    await settle();
    expect(
      container.querySelector('[role="dialog"][aria-label="About Helix Docs"]'),
    ).not.toBeNull();
    expect(container.textContent ?? "").toContain("Helix Docs native editor");
    act(() => {
      buttonWithText("Close")?.click();
    });
    await settle();
    clickAppBarShare();
    await settle();
    expect(
      container.querySelector('[role="dialog"][aria-label="Share Native session doc"]'),
    ).not.toBeNull();
    expect(container.textContent ?? "").toContain("People with access");
    expect(container.textContent ?? "").toContain("Maya Chen");
    openSidePanel();
    await settle();
    // Side-panel tabs are present in the new chrome.
    expect(sidePanelTab("Outline")).not.toBeNull();
    expect(sidePanelTab("Comments")).not.toBeNull();
    expect(sidePanelTab("Suggestions")).not.toBeNull();
    // Comments tab is the default-active tab.
    expect(container.textContent ?? "").toContain("Ada");
    expect(container.textContent ?? "").toContain("Review this section");
    // Switch to Outline tab to read heading anchors.
    clickTab("Outline");
    await settle();
    expect(container.textContent ?? "").toContain("Session heading");
    expect(container.querySelector<HTMLAnchorElement>('a[href="#heading-1"]')?.textContent).toBe(
      "Session heading",
    );
    expect(container.textContent ?? "").toContain("Words");
    expect(container.textContent ?? "").toContain("5");
    expect(container.textContent ?? "").toContain("Session body paragraph");
    // Switch to Suggestions tab to read suggestion content.
    clickTab("Suggestions");
    await settle();
    expect(container.textContent ?? "").toContain("teh heading");
    expect(container.textContent ?? "").toContain("the heading");
    // Switch to Ask tab to use the Ask AI panel.
    clickTab("Ask");
    await settle();
    expect(container.textContent ?? "").toContain("Ask this document");
    expect(platformHost.getCommandPaletteItems().map((item) => item.label)).toEqual(
      expect.arrayContaining([
        "Ask this document",
        "Find in document",
        "Insert bookmark",
        "Insert @person smart chip",
        "Jump to document comments",
        "Export document as PDF",
        "Print document",
      ]),
    );
    // Switch to Versions tab to read version history.
    clickTab("Versions");
    await settle();
    expect(container.textContent ?? "").toContain("Version history");
    expect(container.textContent ?? "").toContain("Update 4");
    expect(container.textContent ?? "").toContain("web.native-document.editor");
    // Switch back to Ask before exercising the ask flow below.
    clickTab("Ask");
    await settle();

    const askQuestion = container.querySelector<HTMLTextAreaElement>(
      "#native-document-ask-question",
    );
    expect(askQuestion).not.toBeNull();
    act(() => {
      if (askQuestion !== null) {
        setTextareaValue(askQuestion, "What is this document about?");
      }
    });
    // Submit the Ask form (not the Ask tab) by clicking the form's submit button.
    act(() => {
      askSubmitButton()?.click();
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledWith("/api/tools/docs.ask.answer", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docId: "doc-1",
        question: "What is this document about?",
        selection: "Session heading\nSession body paragraph",
        body: "Session heading\nSession body paragraph",
        sourceScope: "document",
        citations: [
          {
            label: "Heading: Session heading",
            excerpt: "Session heading",
            sourceScope: "document",
          },
          {
            label: "Session heading",
            excerpt: "Session body paragraph",
            sourceScope: "document",
          },
        ],
      }),
    });
    expect(container.textContent ?? "").toContain("readiness and export risks");
    expect(container.textContent ?? "").toContain("Sources");
    expect(container.textContent ?? "").toContain("Heading: Session heading");
    expect(container.textContent ?? "").toContain("Session body paragraph");
    expect(container.textContent ?? "").toContain("Recent answers");

    // Rename via the EditorAppBar inline title editor: click Edit title, change,
    // commit with Enter (the previous Page/Pageless/Preview/Print/Export buttons
    // live in the File/View menus now and are tested via menu integration).
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Rename"]')?.click();
    });
    const titleInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Document title"]',
    );
    expect(titleInput?.value).toBe("Native session doc");
    act(() => {
      if (titleInput !== null) {
        setInputValue(titleInput, "Renamed session doc");
        titleInput.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
      }
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledWith("/api/tools/docs.update-title", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId: "doc-1", title: "Renamed session doc" }),
    });
    expect(container.textContent ?? "").toContain("Renamed session doc");

    // The download/print/layout buttons that previously decorated the shell
    // chrome are now menu items in File/View — their handlers (exportMutation,
    // window.print, updateLayoutSettings) are exercised in the chrome-context
    // tests rather than via shell DOM.
    void anchorClick;
    void createObjectUrl;
    void revokeObjectUrl;
    void print;
  });

  it("renders API errors without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ error: "document not found" }, { status: 404 }))),
    );

    render("missing-doc");
    await settle();

    expect(container.textContent ?? "").toContain("Could not open this document.");
    expect(container.textContent ?? "").toContain("document not found");
  });

  it("reopens selection ask-history citations and dispatches the anchor jump", async () => {
    const selection = { from: 8, to: 29, text: "selected launch risk" };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "/api/tools/docs.comment.list") {
        return Promise.resolve(Response.json({ comments: [] }));
      }
      if (url === "/api/tools/docs.suggestion.list") {
        return Promise.resolve(Response.json({ suggestions: [] }));
      }
      if (url === "/api/tools/docs.ask.history.list") {
        return Promise.resolve(
          Response.json({
            history: [
              {
                id: "ask-selection-1",
                documentId: "doc-1",
                actorId: "actor-1",
                question: "What is selected?",
                answer: "The selected passage describes launch risk.",
                sourceScope: "selection",
                sourceExcerpt: "selected launch risk",
                metadata: {
                  citations: [
                    {
                      label: "Selected text",
                      excerpt: "selected launch risk",
                      sourceScope: "selection",
                      selection,
                    },
                  ],
                },
                createdAt: "2026-05-23T12:04:00.000Z",
                updatedAt: "2026-05-23T12:04:00.000Z",
              },
            ],
          }),
        );
      }
      if (url === "/api/tools/docs.version.list") {
        return Promise.resolve(Response.json({ versions: [] }));
      }
      return Promise.resolve(Response.json(nativeSessionResponse(selection.text)));
    });
    vi.stubGlobal("fetch", fetchMock);
    const jumps: NativeDocumentSelectionAnchor[] = [];
    const onSelectAnchor = (event: Event) => {
      jumps.push((event as CustomEvent<NativeDocumentAnchorSelectionDetail>).detail.selection);
    };
    window.addEventListener(NATIVE_DOCUMENT_SELECT_ANCHOR_EVENT, onSelectAnchor);

    render("doc-1");
    await settle();
    openSidePanel();
    await settle();
    // Ask history is shown in the Ask tab of the unified side panel.
    clickTab("Ask");
    await settle();
    act(() => {
      buttonWithText("What is selected?")?.click();
    });
    act(() => {
      buttonWithText("Selected text: selected launch risk")?.click();
    });

    expect(jumps).toEqual([selection]);
    window.removeEventListener(NATIVE_DOCUMENT_SELECT_ANCHOR_EVENT, onSelectAnchor);
  });

  it("derives editor decorations from open comments and pending suggestions", () => {
    expect(
      nativeDocumentAnchorDecorationsFromRecords({
        comments: [
          {
            id: "comment-1",
            anchor: {
              kind: "native-document",
              target: "selection",
              selection: { from: 3, to: 9, text: "review" },
            },
          },
          { id: "comment-document", anchor: { kind: "native-document", target: "document" } },
        ],
        suggestions: [
          {
            id: "suggestion-1",
            anchor: {
              kind: "native-document",
              target: "selection",
              selection: { from: 12, to: 18, text: "change" },
            },
          },
        ],
      }),
    ).toEqual([
      { id: "comment-1", kind: "comment", selection: { from: 3, to: 9, text: "review" } },
      { id: "suggestion-1", kind: "suggestion", selection: { from: 12, to: 18, text: "change" } },
    ]);
  });

  it("changes the editor instance key when a restored server snapshot arrives", () => {
    const session = nativeSessionResponse("Current paragraph");
    const currentKey = nativeDocumentEditorInstanceKey(session);

    expect(
      nativeDocumentEditorInstanceKey({
        document: {
          ...session.document,
          updateSeq: session.document.updateSeq + 1,
          stateBase64: nativeStateBase64({
            heading: "Restored heading",
            paragraph: "Restored paragraph",
          }),
        },
      }),
    ).not.toBe(currentKey);
    expect(nativeDocumentEditorInstanceKey(session)).toBe(currentKey);
  });

  function render(documentId: string) {
    act(() => {
      root.render(
        <WebPlatformProvider
          host={platformHost}
          useColorMode={() => ({
            mode: "system",
            resolvedMode: "light",
            setMode: () => undefined,
            toggle: () => undefined,
          })}
        >
          <QueryClientProvider client={queryClient}>
            <NativeDocumentShell documentId={documentId} />
          </QueryClientProvider>
        </WebPlatformProvider>,
      );
    });
  }

  async function settle() {
    for (let index = 0; index < 20; index += 1) {
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    }
  }

  function buttonWithText(label: string): HTMLButtonElement | null {
    return (
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
        button.textContent?.includes(label),
      ) ?? null
    );
  }

  function clickTab(label: string): void {
    // Side panel tabs are rendered by Radix Tabs.Trigger (role=tab) inside a Tabs.List.
    const tabs = Array.from(container.querySelectorAll<HTMLElement>("[role='tab']"));
    const tab = sidePanelTab(label);
    if (tab === undefined) {
      throw new Error(
        `Missing side panel tab: ${label}. Found tabs: ${JSON.stringify(tabs.map((t) => t.getAttribute("aria-label") ?? t.textContent))}`,
      );
    }
    // Radix Tabs.Trigger reacts to mousedown + click in modern versions; in jsdom we
    // need to dispatch a real bubbling MouseEvent for the value change to propagate.
    act(() => {
      tab.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
      );
      tab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
  }

  function sidePanelTab(label: string): HTMLElement | undefined {
    return Array.from(container.querySelectorAll<HTMLElement>("[role='tab']")).find(
      (node) => node.getAttribute("aria-label") === label || node.textContent?.includes(label),
    );
  }

  function clickAppMenu(menuId: string): void {
    const button = container.querySelector<HTMLButtonElement>(`button[data-menu-id="${menuId}"]`);
    if (button === null) {
      throw new Error(`Missing app menu: ${menuId}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
      button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  }

  function clickOpenMenuItem(label: string): void {
    const item =
      Array.from(document.body.querySelectorAll<HTMLElement>("[role='menuitem']")).find((node) =>
        node.textContent?.includes(label),
      ) ?? null;
    if (item === null) {
      throw new Error(
        `Missing open menu item: ${label}. Found: ${JSON.stringify(
          Array.from(document.body.querySelectorAll<HTMLElement>("[role='menuitem']")).map((node) =>
            node.textContent?.trim(),
          ),
        )}`,
      );
    }
    act(() => {
      item.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
      item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      item.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  }

  function clickAppBarShare(): void {
    const button =
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (node) => node.textContent?.trim() === "Share" && node.dataset.menuId !== "share",
      ) ?? null;
    if (button === null) {
      throw new Error("Missing app-bar Share button.");
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  }

  function openSidePanel(): void {
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle comments"]',
    );
    if (toggle === null) {
      throw new Error("Missing side panel toggle.");
    }
    if (toggle.getAttribute("aria-pressed") === "true") {
      return;
    }
    act(() => {
      toggle.click();
    });
  }

  function askSubmitButton(): HTMLButtonElement | null {
    // The Ask panel form contains a submit button with "Ask" text (and a Sparkles icon).
    const form = container.querySelector<HTMLFormElement>("section#native-document-ask-panel form");
    if (form === null) return null;
    return form.querySelector<HTMLButtonElement>("button[type='submit']");
  }
});

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly url: string;
  binaryType: BinaryType = "arraybuffer";
  readyState = FakeWebSocket.CONNECTING;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
  }

  send(): void {
    // The shell suite does not exercise realtime transport behavior.
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

function nativeSessionResponse(paragraph: string) {
  return {
    editor: "document",
    engine: "helix-native-document",
    formatVersion: 1,
    resource: {
      orgId: "org-1",
      resourceId: "doc-1",
      kind: "document",
    },
    document: {
      id: "doc-1",
      orgId: "org-1",
      title: "Native session doc",
      ownerActorId: "actor-1",
      editorEngine: "helix-native-document",
      formatVersion: 1,
      updateSeq: 4,
      stateBase64: nativeStateBase64({
        heading: "Session heading",
        paragraph,
      }),
      stateVectorBase64: "BAUG",
      updatedAt: "2026-05-23T12:00:00.000Z",
    },
    shellRoute: "/docs/:id",
    apiRoute: "/api/editors/documents/:documentId",
    sync: {
      protocol: "yjs",
      route: "/sync/docs/:docId",
      url: "/sync/docs/doc-1?protocol=yjs",
      awareness: true,
    },
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
    input,
    value,
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(
    textarea,
    value,
  );
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function nativeStateBase64(input: {
  readonly heading: string;
  readonly paragraph: string;
}): string {
  const doc = new Y.Doc();
  const heading = new Y.XmlElement("heading");
  (heading.setAttribute as unknown as (name: string, value: number) => void)("level", 1);
  const headingText = new Y.XmlText();
  headingText.insert(0, input.heading);
  heading.insert(0, [headingText]);
  const paragraph = new Y.XmlElement("paragraph");
  const xmlText = new Y.XmlText();
  xmlText.insert(0, input.paragraph);
  paragraph.insert(0, [xmlText]);
  doc.getXmlFragment("default").insert(0, [heading, paragraph]);
  let binary = "";
  for (const byte of Y.encodeStateAsUpdate(doc)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
