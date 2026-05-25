// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocsShell } from "./docs-shell";

const navigateMock = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    navigate: navigateMock,
  }),
}));

vi.mock("@/components/shell", () => ({
  SurfaceFrame: ({
    actions,
    children,
  }: {
    readonly actions?: ReactNode;
    readonly children: ReactNode;
  }) => (
    <main>
      <div>{actions}</div>
      <div>{children}</div>
    </main>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let toolCalls: Array<{ readonly url: string; readonly body: unknown }>;
let createShouldFail: boolean;
let importShouldFail: boolean;
let driveEntries: readonly Record<string, unknown>[];

describe("DocsShell", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    toolCalls = [];
    createShouldFail = false;
    importShouldFail = false;
    driveEntries = [];
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
      },
    });
    fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      toolCalls.push({ url, body });
      if (url === "/api/tools/docs.create") {
        if (createShouldFail) {
          return Promise.resolve(
            Response.json({ error: { message: "Docs service unavailable" } }, { status: 503 }),
          );
        }
        return Promise.resolve(
          Response.json({
            id: "22222222-2222-4222-8222-222222222222",
            title: "Untitled document",
            threadId: "44444444-4444-4444-8444-444444444444",
            ownerActorId: "11111111-1111-4111-8111-111111111111",
            createdByActorId: "11111111-1111-4111-8111-111111111111",
            ydocState: btoa("native-state"),
            ydocStateVector: btoa("native-vector"),
            updateSeq: 0,
            editorEngine: "helix-native-document",
            formatVersion: 1,
            metadata: { createdFrom: "web.docs-shell" },
            deletedAt: null,
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:00:00.000Z",
          }),
        );
      }
      if (url === "/api/tools/docs.import-docx") {
        if (importShouldFail) {
          return Promise.resolve(
            Response.json({ error: { message: "Invalid DOCX package" } }, { status: 400 }),
          );
        }
        return Promise.resolve(
          Response.json({
            id: "33333333-3333-4333-8333-333333333333",
            title: "Launch plan",
            threadId: "44444444-4444-4444-8444-444444444444",
            ownerActorId: "11111111-1111-4111-8111-111111111111",
            createdByActorId: "11111111-1111-4111-8111-111111111111",
            ydocState: btoa("native-state"),
            ydocStateVector: btoa("native-vector"),
            updateSeq: 0,
            editorEngine: "helix-native-document",
            formatVersion: 1,
            metadata: { importedFrom: "docx" },
            deletedAt: null,
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:00:00.000Z",
          }),
        );
      }
      if (url === "/api/tools/docs.migrate-native") {
        return Promise.resolve(
          Response.json({
            id: "33333333-3333-4333-8333-333333333333",
            title: "Legacy plan",
            threadId: "44444444-4444-4444-8444-444444444444",
            ownerActorId: "11111111-1111-4111-8111-111111111111",
            createdByActorId: "11111111-1111-4111-8111-111111111111",
            ydocState: btoa("native-state"),
            ydocStateVector: btoa("native-vector"),
            updateSeq: 2,
            editorEngine: "helix-native-document",
            formatVersion: 1,
            metadata: { migratedFromEditorEngine: "legacy-yjs" },
            deletedAt: null,
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:05:00.000Z",
          }),
        );
      }
      return Promise.resolve(Response.json({ entries: driveEntries }));
    });
    vi.stubGlobal("fetch", fetchMock);
    navigateMock.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  it("creates native documents without falling back to fake offline ids", async () => {
    render();
    await settle();

    clickButton("New");
    await settle();

    expect(navigateMock).toHaveBeenCalledWith({
      to: "/docs/$documentId",
      params: { documentId: "22222222-2222-4222-8222-222222222222" },
    });

    navigateMock.mockClear();
    createShouldFail = true;
    clickButton("New");
    await settle();

    expect(container.textContent).toContain("Document creation failed — Docs service unavailable");
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("imports DOCX files into native documents and opens the created doc", async () => {
    render();
    await settle();

    dispatchDocxFile("Launch plan.docx", [1, 2, 3]);
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/docs.import-docx")?.body).toEqual({
      filename: "Launch plan.docx",
      title: "Launch plan",
      contentBase64: "AQID",
      folderId: null,
      metadata: { source: "web.docs-shell.import-docx" },
    });
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/docs/$documentId",
      params: { documentId: "33333333-3333-4333-8333-333333333333" },
    });
  });

  it("surfaces DOCX import failures without navigating", async () => {
    importShouldFail = true;
    render();
    await settle();

    dispatchDocxFile("Broken.docx", [9, 9, 9]);
    await settle();

    expect(container.textContent).toContain("DOCX import failed — Invalid DOCX package");
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("migrates explicit legacy Docs rows and opens the native document", async () => {
    driveEntries = [
      {
        id: "33333333-3333-4333-8333-333333333333",
        type: "file",
        name: "Legacy plan.helixdoc",
        folderId: null,
        ownerActorId: "11111111-1111-4111-8111-111111111111",
        app: "docs",
        mimeType: "application/vnd.helix.document",
        metadata: {
          app: "docs",
          title: "Legacy plan",
          editorEngine: "legacy-yjs",
          formatVersion: 1,
        },
        deletedAt: null,
        createdAt: "2026-05-20T12:00:00.000Z",
        updatedAt: "2026-05-20T12:00:00.000Z",
      },
    ];
    render();
    await settle();

    expect(container.textContent).toContain("Legacy plan");
    clickButton("Migrate");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/docs.migrate-native",
      body: { docId: "33333333-3333-4333-8333-333333333333" },
    });
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/docs/$documentId",
      params: { documentId: "33333333-3333-4333-8333-333333333333" },
    });
  });

  it("opens OOXML Drive rows through the legacy edit route", async () => {
    driveEntries = [
      {
        id: "55555555-5555-4555-8555-555555555555",
        type: "file",
        name: "Vendor contract.docx",
        folderId: null,
        ownerActorId: "11111111-1111-4111-8111-111111111111",
        app: "drive",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        metadata: {
          title: "Vendor contract",
          editorEngine: "onlyoffice-ooxml",
        },
        deletedAt: null,
        createdAt: "2026-05-20T12:00:00.000Z",
        updatedAt: "2026-05-20T12:00:00.000Z",
      },
    ];
    render();
    await settle();

    expect(container.textContent).toContain("Vendor contract");
    clickButton("Vendor contract");

    expect(navigateMock).toHaveBeenCalledWith({
      to: "/edit/$objectId",
      params: { objectId: "55555555-5555-4555-8555-555555555555" },
    });
  });
});

function render() {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <DocsShell />
      </QueryClientProvider>,
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

function dispatchDocxFile(filename: string, bytes: readonly number[]) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Import DOCX"]');
  expect(input).not.toBeNull();
  const fileBytes = Uint8Array.from(bytes);
  const file = new File([fileBytes], filename, {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: () => Promise.resolve(Uint8Array.from(bytes).buffer),
  });
  Object.defineProperty(input, "files", {
    configurable: true,
    get: () => [file],
  });

  act(() => {
    input?.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function clickButton(label: string): void {
  const target =
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((candidate) =>
      candidate.textContent?.includes(label),
    ) ??
    Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find((candidate) =>
      candidate.textContent?.includes(label),
    );
  if (target === undefined) {
    throw new Error(`Missing button: ${label}`);
  }
  act(() => {
    target.click();
  });
}
