// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WebPlatformProvider, createWebPlatformHost } from "@helix/sdk-web";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  NATIVE_DOCUMENT_SELECT_ANCHOR_EVENT,
  type NativeDocumentAnchorSelectionDetail,
  type NativeDocumentSelectionAnchor,
} from "./native-document-anchors";
import { NativeDocumentShell } from "./native-document-shell";

const nativeEditorMock = vi.hoisted(() => ({
  selectionAnchor: null as NativeDocumentSelectionAnchor | null,
}));

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

vi.mock("./native-document-editor", async () => {
  const React = await import("react");
  return {
    NativeDocumentEditor({
      onSelectionAnchorChange,
    }: {
      readonly onSelectionAnchorChange?: (selection: NativeDocumentSelectionAnchor | null) => void;
    }) {
      React.useEffect(() => {
        onSelectionAnchorChange?.(nativeEditorMock.selectionAnchor);
      }, [onSelectionAnchorChange]);
      return <div className="native-document-editor__content-layout" />;
    },
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("NativeDocumentShell ask citations", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    nativeEditorMock.selectionAnchor = null;
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

  it("submits selected-text citations and keeps the returned citation jumpable", async () => {
    const selection = { from: 8, to: 30, text: "selected text citation" };
    nativeEditorMock.selectionAnchor = selection;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "/api/tools/docs.ask.answer") {
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        return Promise.resolve(
          Response.json({
            id: "ask-1",
            documentId: "doc-1",
            actorId: "actor-1",
            question: (body as { readonly question?: string }).question ?? "",
            answer: "The selected text supports the answer.",
            sourceScope: "selection",
            sourceExcerpt: selection.text,
            metadata: {
              citations: (body as { readonly citations?: unknown }).citations ?? [],
            },
            createdAt: "2026-05-25T12:00:00.000Z",
            updatedAt: "2026-05-25T12:00:00.000Z",
          }),
        );
      }
      if (url === "/api/tools/docs.comment.list") {
        return Promise.resolve(Response.json({ comments: [] }));
      }
      if (url === "/api/tools/docs.suggestion.list") {
        return Promise.resolve(Response.json({ suggestions: [] }));
      }
      if (url === "/api/tools/docs.ask.history.list") {
        return Promise.resolve(Response.json({ history: [] }));
      }
      if (url === "/api/tools/docs.version.list") {
        return Promise.resolve(Response.json({ versions: [] }));
      }
      return Promise.resolve(Response.json(nativeSessionResponse()));
    });
    vi.stubGlobal("fetch", fetchMock);
    const jumps: NativeDocumentAnchorSelectionDetail[] = [];
    const onSelectAnchor = (event: Event) => {
      jumps.push((event as CustomEvent<NativeDocumentAnchorSelectionDetail>).detail);
    };
    window.addEventListener(NATIVE_DOCUMENT_SELECT_ANCHOR_EVENT, onSelectAnchor);

    render();
    await settle();
    // Ask AI lives in the collapsible side panel; open the panel before switching tabs.
    clickButton("Show document outline");
    await settle();
    clickTab("Ask");
    await settle();
    act(() => {
      setQuestion("What supports this?");
    });
    // Submit the Ask form via its submit button (avoid matching the "Ask" tab trigger).
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
        question: "What supports this?",
        selection: "selected text citation",
        body: "Session heading\nBody paragraph for ask citations",
        sourceScope: "selection",
        citations: [
          {
            label: "Selected text",
            excerpt: "selected text citation",
            sourceScope: "selection",
            selection,
          },
        ],
      }),
    });
    act(() => {
      buttonWithText("Selected text: selected text citation")?.click();
    });

    expect(jumps).toEqual([{ documentId: "doc-1", selection }]);
    window.removeEventListener(NATIVE_DOCUMENT_SELECT_ANCHOR_EVENT, onSelectAnchor);
  });

  function render(): void {
    const platformHost = createWebPlatformHost({
      queryClient,
      getColorMode: () => "system",
    });
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
            <NativeDocumentShell documentId="doc-1" />
          </QueryClientProvider>
        </WebPlatformProvider>,
      );
    });
  }

  async function settle(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    }
  }

  function setQuestion(value: string): void {
    const textarea = container.querySelector<HTMLTextAreaElement>("#native-document-ask-question");
    if (textarea === null) {
      throw new Error("Missing Ask question textarea.");
    }
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function buttonWithText(label: string): HTMLButtonElement | null {
    return (
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
        button.textContent?.includes(label),
      ) ?? null
    );
  }

  function clickTab(label: string): void {
    const tab = Array.from(container.querySelectorAll<HTMLElement>("[role='tab']")).find((node) =>
      (node.getAttribute("aria-label") ?? node.textContent ?? "").includes(label),
    );
    if (tab === undefined) {
      const tabs = Array.from(container.querySelectorAll<HTMLElement>("[role='tab']")).map(
        (node) => node.textContent?.trim() ?? "",
      );
      const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).map(
        (node) => node.getAttribute("aria-label") ?? node.textContent?.trim() ?? "",
      );
      throw new Error(
        `Missing side panel tab: ${label}. Tabs: ${tabs.join(", ") || "(none)"}. Buttons: ${
          buttons.join(", ") || "(none)"
        }`,
      );
    }
    // Radix Tabs.Trigger needs a real bubbling MouseEvent in jsdom to fire onValueChange.
    act(() => {
      tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      tab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
  }

  function clickButton(label: string): void {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (node) => node.getAttribute("aria-label") === label || node.textContent?.includes(label),
    );
    if (button === undefined) {
      throw new Error(`Missing button: ${label}`);
    }
    act(() => {
      button.click();
    });
  }

  function askSubmitButton(): HTMLButtonElement | null {
    const form = container.querySelector<HTMLFormElement>(
      "section#native-document-ask-panel form",
    );
    if (form === null) return null;
    return form.querySelector<HTMLButtonElement>("button[type='submit']");
  }
});

function nativeSessionResponse() {
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
      stateBase64: nativeStateBase64(),
      stateVectorBase64: "BAUG",
      updatedAt: "2026-05-25T12:00:00.000Z",
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

function nativeStateBase64(): string {
  const doc = new Y.Doc();
  const heading = new Y.XmlElement("heading");
  (heading.setAttribute as unknown as (name: string, value: number) => void)("level", 1);
  const headingText = new Y.XmlText();
  headingText.insert(0, "Session heading");
  heading.insert(0, [headingText]);
  const paragraph = new Y.XmlElement("paragraph");
  const xmlText = new Y.XmlText();
  xmlText.insert(0, "Body paragraph for ask citations");
  paragraph.insert(0, [xmlText]);
  doc.getXmlFragment("default").insert(0, [heading, paragraph]);
  let binary = "";
  for (const byte of Y.encodeStateAsUpdate(doc)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
