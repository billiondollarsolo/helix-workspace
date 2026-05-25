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
} from "./native-document-shell";

vi.mock("@tanstack/react-router", () => ({
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
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    Object.defineProperty(window, "print", { configurable: true, value: print });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    const askHistory: unknown[] = [];
    const stateBase64 = nativeStateBase64({
      heading: "Session heading",
      paragraph: "Session body paragraph",
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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
    expect(container.textContent ?? "").toContain("Connected");
    expect(container.textContent ?? "").toContain("helix-native-document");
    expect(container.textContent ?? "").toContain("Outline");
    expect(container.textContent ?? "").toContain("Session heading");
    expect(container.querySelector<HTMLAnchorElement>('a[href="#heading-1"]')?.textContent).toBe(
      "Session heading",
    );
    expect(container.textContent ?? "").toContain("Words");
    expect(container.textContent ?? "").toContain("5");
    expect(container.textContent ?? "").toContain("Session body paragraph");
    expect(container.textContent ?? "").toContain("Comments");
    expect(container.textContent ?? "").toContain("Ada");
    expect(container.textContent ?? "").toContain("Review this section");
    expect(container.textContent ?? "").toContain("Suggestions");
    expect(container.textContent ?? "").toContain("teh heading");
    expect(container.textContent ?? "").toContain("the heading");
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
    expect(container.textContent ?? "").toContain("Version history");
    expect(container.textContent ?? "").toContain("Update 4");
    expect(container.textContent ?? "").toContain("web.native-document.editor");
    expect(container.textContent ?? "").toContain("YJS");

    const askQuestion = container.querySelector<HTMLTextAreaElement>(
      "#native-document-ask-question",
    );
    expect(askQuestion).not.toBeNull();
    act(() => {
      if (askQuestion !== null) {
        setTextareaValue(askQuestion, "What is this document about?");
      }
    });
    act(() => {
      buttonWithText("Ask")?.click();
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

    act(() => {
      buttonWithText("Rename")?.click();
    });
    const titleInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Document title"]',
    );
    expect(titleInput?.value).toBe("Native session doc");
    act(() => {
      if (titleInput !== null) {
        setInputValue(titleInput, "Renamed session doc");
      }
    });
    act(() => {
      buttonWithText("Save")?.click();
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledWith("/api/tools/docs.update-title", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId: "doc-1", title: "Renamed session doc" }),
    });
    expect(container.textContent ?? "").toContain("Renamed session doc");
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Document title"]'),
    ).toBeNull();

    const documentPage = container.querySelector<HTMLElement>(".native-document-page");
    const documentContentLayout = container.querySelector<HTMLElement>(
      ".native-document-editor__content-layout",
    );
    expect(documentPage?.dataset.layoutMode).toBe("pageless");
    expect(documentPage?.dataset.columnCount).toBe("2");
    expect(documentPage?.style.columnCount).toBe("");
    expect(documentContentLayout?.dataset.columnCount).toBe("2");

    act(() => {
      buttonWithText("Page")?.click();
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledWith("/api/tools/docs.update-layout", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docId: "doc-1",
        layoutSettings: {
          layoutMode: "page",
          columnCount: 2,
          sections: [
            {
              id: "default",
              title: "Document",
              layoutMode: "page",
              columnCount: 2,
              pageSize: "a4",
              orientation: "landscape",
            },
          ],
        },
      }),
    });
    expect(documentPage?.dataset.layoutMode).toBe("page");

    act(() => {
      buttonWithText("1 col")?.click();
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledWith("/api/tools/docs.update-layout", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docId: "doc-1",
        layoutSettings: {
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
      }),
    });
    expect(documentPage?.dataset.columnCount).toBe("1");
    expect(documentPage?.style.columnCount).toBe("");
    expect(documentContentLayout?.dataset.columnCount).toBe("1");

    const previewButton = buttonWithText("Preview");
    expect(previewButton?.getAttribute("aria-pressed")).toBe("false");
    act(() => {
      previewButton?.click();
    });
    expect(print).not.toHaveBeenCalled();
    expect(previewButton?.getAttribute("aria-pressed")).toBe("true");

    act(() => {
      buttonWithText("Print")?.click();
    });
    expect(print).toHaveBeenCalledTimes(1);

    act(() => {
      buttonWithText("DOCX")?.click();
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledWith("/api/tools/docs.export", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId: "doc-1", format: "docx", includeComments: true }),
    });
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:doc-export");

    act(() => {
      buttonWithText("EPUB")?.click();
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledWith("/api/tools/docs.export", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId: "doc-1", format: "epub", includeComments: true }),
    });
    expect(anchorClick).toHaveBeenCalledTimes(2);
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
});

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
