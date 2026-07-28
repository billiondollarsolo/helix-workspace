// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WebPlatformProvider, createWebPlatformHost } from "@helix/sdk-web";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { docsQueryKeys } from "./queries";
import { NativeDocumentShell } from "./native-document-shell";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { readonly children: ReactNode; readonly to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("./native-document-editor", () => ({
  NativeDocumentEditor: ({
    onContentChange,
  }: {
    readonly onContentChange?: (() => void) | undefined;
  }) => (
    <button type="button" aria-label="Simulate document edit" onClick={onContentChange}>
      Simulate edit
    </button>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("NativeDocumentShell version refresh", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url === "/api/tools/docs.comment.list") {
          return Promise.resolve(Response.json({ comments: [] }));
        }
        if (url === "/api/tools/docs.suggestion.list") {
          return Promise.resolve(Response.json({ suggestions: [] }));
        }
        return Promise.resolve(Response.json(nativeSessionResponse()));
      }),
    );
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("debounces version-history invalidation after editor updates", async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <WebPlatformProvider
            host={createWebPlatformHost({
              queryClient,
              getColorMode: () => "system",
            })}
            useColorMode={() => ({
              mode: "system",
              resolvedMode: "light",
              setMode: () => undefined,
              toggle: () => undefined,
            })}
          >
            <NativeDocumentShell documentId="doc-1" />
          </WebPlatformProvider>
        </QueryClientProvider>,
      );
    });
    await settle();

    const versionKey = docsQueryKeys.versions("doc-1");
    queryClient.setQueryData(versionKey, { pages: [], pageParams: [] });
    expect(queryClient.getQueryState(versionKey)?.isInvalidated).toBe(false);

    const editButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Simulate document edit"]',
    );
    if (editButton === null) {
      throw new Error(`Missing mocked document editor: ${container.textContent ?? ""}`);
    }

    vi.useFakeTimers();
    act(() => {
      editButton.click();
      vi.advanceTimersByTime(899);
    });
    expect(queryClient.getQueryState(versionKey)?.isInvalidated).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(queryClient.getQueryState(versionKey)?.isInvalidated).toBe(true);
  });
});

function nativeSessionResponse() {
  const ydoc = new Y.Doc();
  ydoc.getXmlFragment("prosemirror");
  const stateBase64 = btoa(String.fromCharCode(...Y.encodeStateAsUpdate(ydoc)));
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
      title: "Version refresh proof",
      ownerActorId: "actor-1",
      editorEngine: "helix-native-document",
      formatVersion: 1,
      updateSeq: 4,
      stateBase64,
      stateVectorBase64: null,
      updatedAt: "2026-07-27T12:00:00.000Z",
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

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
