// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocsApiDocument } from "./api";
import { DocEditor } from "./doc-editor";
import { DocList, filterDocuments } from "./doc-list";
import { DOC_LIST, type DocSummary } from "./data";
import { mergeBackendDocuments, mergeDriveDocuments } from "./docs-shell";
import { ShareDialog } from "./share-dialog";
import type { DriveApiEntry } from "@/features/drive/api";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("filterDocuments", () => {
  it("returns every seeded document for the All folder", () => {
    expect(filterDocuments(DOC_LIST, "all", "")).toHaveLength(DOC_LIST.length);
  });

  it("scopes the Owned-by-me folder to documents the user owns", () => {
    const mine = filterDocuments(DOC_LIST, "mine", "");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((document) => document.mine)).toBe(true);
  });

  it("scopes the Shared folder to documents the user does not own", () => {
    const shared = filterDocuments(DOC_LIST, "shared", "");
    expect(shared.every((document) => !document.mine)).toBe(true);
  });

  it("returns no documents for the Trash folder", () => {
    expect(filterDocuments(DOC_LIST, "trash", "")).toHaveLength(0);
  });

  it("filters a tag folder by the document folder", () => {
    const product = filterDocuments(DOC_LIST, "Product", "");
    expect(product.length).toBeGreaterThan(0);
    expect(product.every((document) => document.folder === "Product")).toBe(true);
  });

  it("narrows results by a case-insensitive search query", () => {
    const results = filterDocuments(DOC_LIST, "all", "roadmap");
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toContain("Q3 Roadmap");
  });
});

describe("mergeBackendDocuments", () => {
  const backendRow: DocsApiDocument = {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Backend roadmap",
    threadId: null,
    ownerActorId: null,
    createdByActorId: null,
    ydocState: null,
    ydocStateVector: null,
    updateSeq: 0,
    metadata: {},
    deletedAt: null,
    createdAt: "2026-05-20T10:00:00.000Z",
    updatedAt: "2026-05-20T10:00:00.000Z",
  };

  it("returns the seed list unchanged when the backend yields nothing", () => {
    expect(mergeBackendDocuments(DOC_LIST, undefined)).toBe(DOC_LIST);
    expect(mergeBackendDocuments(DOC_LIST, [])).toBe(DOC_LIST);
  });

  it("merges backend documents ahead of the seed list", () => {
    const merged = mergeBackendDocuments(DOC_LIST, [backendRow]);
    expect(merged).toHaveLength(DOC_LIST.length + 1);
    expect(merged[0]?.id).toBe(backendRow.id);
    expect(merged[0]?.source).toBe("backend");
  });
});

describe("mergeDriveDocuments", () => {
  const driveRow: DocSummary = {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Drive roadmap",
    owner: "You",
    modified: "Just now",
    shared: 1,
    folder: "Product",
    starred: false,
    mine: true,
    source: "backend",
  };

  it("returns the seed list unchanged when drive yields nothing", () => {
    expect(mergeDriveDocuments(DOC_LIST, undefined)).toBe(DOC_LIST);
    expect(mergeDriveDocuments(DOC_LIST, [])).toBe(DOC_LIST);
  });

  it("merges drive documents ahead of the seed list", () => {
    const merged = mergeDriveDocuments(DOC_LIST, [driveRow]);
    expect(merged).toHaveLength(DOC_LIST.length + 1);
    expect(merged[0]?.id).toBe(driveRow.id);
    expect(merged[0]?.source).toBe("backend");
  });
});

describe("Docs list page — drive.list data source", () => {
  const DRIVE_DOC_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  function makeDriveEntry(overrides: Partial<DriveApiEntry> = {}): DriveApiEntry {
    return {
      id: DRIVE_DOC_ID,
      type: "file",
      name: "Drive Strategy Doc",
      folderId: null,
      ownerActorId: "actor-1",
      app: "docs",
      metadata: { title: "Drive Strategy Doc" },
      deletedAt: null,
      createdAt: "2026-05-20T10:00:00.000Z",
      updatedAt: "2026-05-20T10:00:00.000Z",
      ...overrides,
    };
  }

  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchCalls: Array<{ url: string; body: unknown }>;

  beforeEach(() => {
    fetchCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        fetchCalls.push({ url, body });

        if (url === "/api/auth/get-session") {
          return Promise.resolve(Response.json({}));
        }
        if (url === "/api/tools/drive.list") {
          return Promise.resolve(
            Response.json({ entries: [makeDriveEntry()] }),
          );
        }
        return Promise.resolve(Response.json({}, { status: 200 }));
      }),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  async function settle() {
    for (let tick = 0; tick < 20; tick += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it("calls drive.list with app:\"docs\" for the list page", async () => {
    // Use a lightweight wrapper that calls the docs list query directly,
    // avoiding the full DocsShell which requires router/shell context.
    const { docsListFromDriveQueryOptions } = await import("./queries");
    const { useQuery } = await import("@tanstack/react-query");
    function TestHarness() {
      useQuery(docsListFromDriveQueryOptions({ limit: 100 }));
      return null;
    }
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TestHarness />
        </QueryClientProvider>,
      );
    });
    await settle();

    const driveCall = fetchCalls.find((c) => c.url === "/api/tools/drive.list");
    expect(driveCall).toBeDefined();
    expect((driveCall?.body as { app: string }).app).toBe("docs");
  });

  it("renders the drive entry name in the list and opens it by its shared id", () => {
    let openedId: string | null = null;
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <DocList
            documents={[
              {
                id: DRIVE_DOC_ID,
                title: "Drive Strategy Doc",
                owner: "You",
                modified: "Just now",
                shared: 1,
                folder: "Product",
                starred: false,
                mine: true,
                source: "backend",
              },
            ]}
            folder="all"
            query=""
            onFolder={() => undefined}
            onNewDoc={() => undefined}
            onOpenDoc={(id) => { openedId = id; }}
            isBackendUnavailable={false}
          />
        </QueryClientProvider>,
      );
    });

    expect(container.textContent).toContain("Drive Strategy Doc");
    const row = container.querySelector<HTMLButtonElement>("button.list-row");
    expect(row).not.toBeNull();
    act(() => { row?.click(); });
    expect(openedId).toBe(DRIVE_DOC_ID);
  });
});

describe("Docs UI", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
  });

  function noop() {
    /* test stub */
  }

  /** Wraps a node in a QueryClientProvider so TanStack Query hooks resolve. */
  function withQuery(node: ReactNode): ReactNode {
    return createElement(QueryClientProvider, { client: queryClient }, node);
  }

  /** Sets an input's value the way React expects so `onChange` fires. */
  function typeInto(input: HTMLInputElement, value: string) {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
      ?.set as ((this: HTMLInputElement, value: string) => void) | undefined;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("renders the Recent grid and All-documents table for the list view", () => {
    act(() => {
      root.render(
        <DocList
          documents={DOC_LIST}
          folder="all"
          query=""
          onFolder={noop}
          onNewDoc={noop}
          onOpenDoc={noop}
          isBackendUnavailable={false}
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Recent");
    expect(text).toContain("All documents");
    expect(text).toContain("Q3 Roadmap — final draft");
    expect(container.querySelector('[aria-label="Docs navigation"]')).not.toBeNull();
  });

  it("shows a folder-specific empty state for the Trash folder", () => {
    act(() => {
      root.render(
        <DocList
          documents={DOC_LIST}
          folder="trash"
          query=""
          onFolder={noop}
          onNewDoc={noop}
          onOpenDoc={noop}
          isBackendUnavailable={false}
        />,
      );
    });

    expect(container.textContent ?? "").toContain("Trash is empty");
  });

  it("surfaces a backend-unavailable notice in the list view", () => {
    act(() => {
      root.render(
        <DocList
          documents={DOC_LIST}
          folder="all"
          query=""
          onFolder={noop}
          onNewDoc={noop}
          onOpenDoc={noop}
          isBackendUnavailable
        />,
      );
    });

    expect(container.textContent ?? "").toContain("Docs backend unavailable");
  });

  it("opens a document when an All-documents row is clicked", () => {
    let openedId = "";
    act(() => {
      root.render(
        <DocList
          documents={DOC_LIST}
          folder="all"
          query=""
          onFolder={noop}
          onNewDoc={noop}
          onOpenDoc={(id) => {
            openedId = id;
          }}
          isBackendUnavailable={false}
        />,
      );
    });

    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>("button.list-row"));
    expect(rows.length).toBe(DOC_LIST.length);
    act(() => {
      rows[0]?.click();
    });
    expect(openedId).toBe(DOC_LIST[0]?.id);
  });

  it("renders the editor with outline, toolbar, title, and Comments rail", () => {
    const document_: DocSummary = DOC_LIST[0]!;
    act(() => {
      root.render(withQuery(<DocEditor document={document_} onBack={noop} onShare={noop} />));
    });

    expect(container.querySelector('[aria-label="Document outline"]')).not.toBeNull();
    expect(container.querySelector('[role="toolbar"]')).not.toBeNull();
    expect(container.querySelector('aside[aria-label="Comments"]')).not.toBeNull();
    // Seed (synthetic-id) documents render offline — the title bar shows the
    // offline-draft chip rather than a live "editing" presence count.
    expect(container.textContent ?? "").toContain("Offline draft");
  });

  it("switches the right rail to Suggestions", () => {
    act(() => {
      root.render(withQuery(<DocEditor document={DOC_LIST[0]!} onBack={noop} onShare={noop} />));
    });

    const historyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Suggestions"]',
    );
    expect(historyButton).not.toBeNull();
    act(() => {
      historyButton?.click();
    });

    expect(container.querySelector('aside[aria-label="Version history"]')).not.toBeNull();
    // Seed documents are not backend-backed, so the rail shows the not-saved
    // empty state rather than live suggestions.
    expect(container.textContent ?? "").toContain("Not saved yet");
  });

  it("opens the slash menu and filters its items", () => {
    act(() => {
      root.render(withQuery(<DocEditor document={DOC_LIST[0]!} onBack={noop} onShare={noop} />));
    });

    const trigger = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Type / to insert a block"),
    );
    expect(trigger).not.toBeUndefined();
    act(() => {
      trigger?.click();
    });

    const menu = container.querySelector('[aria-label="Insert block"]');
    expect(menu).not.toBeNull();
    expect(menu?.textContent ?? "").toContain("Heading 1");

    const filterInput = menu?.querySelector("input");
    act(() => {
      if (filterInput) {
        typeInto(filterInput, "code");
      }
    });
    expect(menu?.textContent ?? "").toContain("Code block");
    expect(menu?.textContent ?? "").not.toContain("Heading 1");
  });

  it("makes the title editable when the title button is clicked", () => {
    act(() => {
      root.render(withQuery(<DocEditor document={DOC_LIST[0]!} onBack={noop} onShare={noop} />));
    });

    const titleButton = container.querySelector<HTMLButtonElement>("button.docs-title-button");
    expect(titleButton).not.toBeNull();
    act(() => {
      titleButton?.click();
    });

    const titleInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Document title"]',
    );
    expect(titleInput).not.toBeNull();
    expect(titleInput?.value).toBe(DOC_LIST[0]?.title);
  });

  it("renders the Share dialog with people and General access", () => {
    act(() => {
      root.render(
        <ShareDialog
          documentTitle="Q3 Roadmap"
          documentId="11111111-1111-4111-8111-111111111111"
          onClose={noop}
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("People with access");
    expect(text).toContain("General access");
    expect(text).toContain("Mira Okafor");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
