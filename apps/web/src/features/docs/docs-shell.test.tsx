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
let digestSpy: { mockRestore: () => void };

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
    digestSpy = vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
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
      if (url === "/api/tools/drive.upload") {
        if (importShouldFail) {
          return Promise.resolve(
            Response.json({ error: { message: "Drive upload failed" } }, { status: 503 }),
          );
        }
        return Promise.resolve(
          Response.json({
            objectId: "33333333-3333-4333-8333-333333333333",
            orgId: "org-1",
            ownerActorId: "11111111-1111-4111-8111-111111111111",
            name: (body as { name?: string }).name ?? "Launch plan.docx",
            folderId: null,
            storageKey: "drive/Launch plan.docx",
            mimeType:
              (body as { mimeType?: string }).mimeType ??
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            byteSize: (body as { byteSize?: number }).byteSize ?? 3,
            sha256: "0".repeat(64),
            status: "pending_upload",
            uploadUrl: null,
            uploadHeaders: {},
            metadata: {},
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:00:00.000Z",
          }),
        );
      }
      if (url === "/api/tools/drive.finalize") {
        return Promise.resolve(
          Response.json({
            id: "version-1",
            orgId: "org-1",
            objectId: (body as { objectId?: string }).objectId,
            versionNumber: 1,
            storageKey: (body as { storageKey?: string }).storageKey,
            mimeType: (body as { mimeType?: string }).mimeType,
            byteSize: (body as { byteSize?: number }).byteSize,
            sha256: "0".repeat(64),
            metadata: {},
            createdByActorId: "11111111-1111-4111-8111-111111111111",
            createdAt: "2026-05-20T12:00:00.000Z",
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
      if (url === "/api/tools/drive.trash") {
        return Promise.resolve(Response.json({ id: (body as { objectId?: string }).objectId }));
      }
      if (url === "/api/tools/drive.restore") {
        return Promise.resolve(Response.json({ id: (body as { objectId?: string }).objectId }));
      }
      if (url === "/api/tools/drive.delete") {
        return Promise.resolve(Response.json({ ok: true }));
      }
      if (url === "/api/tools/drive.star.set") {
        return Promise.resolve(
          Response.json({
            id: (body as { objectId?: string }).objectId,
            metadata: { starred: (body as { starred?: boolean }).starred },
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
    digestSpy.mockRestore();
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

  it("uploads document files as raw Drive objects and opens the copy/preview flow", async () => {
    render();
    await settle();

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Import document"]');
    expect(input?.accept).toContain(".docx");
    expect(input?.accept).toContain(".doc");
    expect(input?.accept).toContain(".odt");
    expect(input?.accept).toContain(".rtf");
    dispatchDocumentFile(
      "Launch plan.docx",
      [1, 2, 3],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.upload")?.body).toMatchObject({
      name: "Launch plan.docx",
      folderId: null,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      byteSize: 3,
    });
    expect(toolCalls.some((call) => call.url === "/api/tools/docs.import-docx")).toBe(false);
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/open/$objectId",
      params: { objectId: "33333333-3333-4333-8333-333333333333" },
    });
  });

  it("uploads legacy Word files as raw Drive objects before the open decision", async () => {
    render();
    await settle();

    dispatchDocumentFile("Legacy memo.doc", [4, 5, 6], "application/msword");
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.upload")?.body).toMatchObject({
      name: "Legacy memo.doc",
      folderId: null,
      mimeType: "application/msword",
      byteSize: 3,
    });
    expect(toolCalls.some((call) => call.url === "/api/tools/docs.import-docx")).toBe(false);
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/open/$objectId",
      params: { objectId: "33333333-3333-4333-8333-333333333333" },
    });
  });

  it("surfaces document upload failures without navigating", async () => {
    importShouldFail = true;
    render();
    await settle();

    dispatchDocumentFile(
      "Broken.docx",
      [9, 9, 9],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    await settle();

    expect(container.textContent).toContain("Document import failed — Drive upload failed");
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
    vi.mocked(window.localStorage.getItem).mockReturnValue("list");
    render();
    await settle();

    expect(container.textContent).toContain("Legacy plan");
    clickButton("More actions for Legacy plan");
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

  it("opens OOXML Drive rows through the universal copy/preview route", async () => {
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
      to: "/docs/$documentId",
      params: { documentId: "55555555-5555-4555-8555-555555555555" },
      search: { open: "office" },
    });
  });

  it("loads more document rows through Drive when the first page is full", async () => {
    driveEntries = Array.from({ length: 101 }, (_, index) =>
      documentDriveEntry({
        id: `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`,
        name: `Document ${String(index).padStart(3, "0")}.docx`,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    );

    render();
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.list")?.body).toMatchObject({
      app: "docs",
      limit: 101,
    });
    clickButton("Show more documents");
    await settle();

    expect(
      toolCalls.filter((call) => call.url === "/api/tools/drive.list").at(-1)?.body,
    ).toMatchObject({ app: "docs", limit: 201 });
  });

  it("moves document list rows to trash through Drive", async () => {
    const objectId = "66666666-6666-4666-8666-666666666666";
    driveEntries = [
      documentDriveEntry({
        id: objectId,
        name: "Research brief.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ];
    vi.mocked(window.localStorage.getItem).mockReturnValue("list");
    render();
    await settle();

    clickButton("More actions for Research brief.docx");
    clickButton("Move to trash");
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.trash")?.body).toEqual({
      objectId,
    });
    expect(toolCalls.some((call) => call.url.includes("docs.delete"))).toBe(false);
  });

  it("stars document list rows through Drive", async () => {
    const objectId = "66666666-6666-4666-8666-666666666666";
    driveEntries = [
      documentDriveEntry({
        id: objectId,
        name: "Research brief.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ];
    vi.mocked(window.localStorage.getItem).mockReturnValue("list");
    render();
    await settle();

    clickButton("More actions for Research brief.docx");
    clickMenuItem("Star");
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.star.set")?.body).toEqual({
      objectId,
      starred: true,
    });
  });

  it("restores and permanently deletes trashed documents through Drive", async () => {
    const objectId = "77777777-7777-4777-8777-777777777777";
    driveEntries = [
      documentDriveEntry({
        id: objectId,
        name: "Deleted brief.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        deletedAt: "2026-05-22T12:00:00.000Z",
      }),
    ];
    vi.mocked(window.localStorage.getItem).mockReturnValue("list");
    render();
    await settle();

    clickButton("Trash");
    await settle();
    clickButton("More actions for Deleted brief.docx");
    clickButton("Restore");
    await settle();
    clickButton("More actions for Deleted brief.docx");
    clickButton("Delete forever");
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.restore")?.body).toEqual({
      objectId,
      folderId: null,
    });
    expect(toolCalls.find((call) => call.url === "/api/tools/drive.delete")?.body).toEqual({
      objectId,
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

function dispatchDocumentFile(filename: string, bytes: readonly number[], mimeType: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Import document"]');
  expect(input).not.toBeNull();
  const fileBytes = Uint8Array.from(bytes);
  const file = new File([fileBytes], filename, { type: mimeType });
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
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) =>
        candidate.textContent?.includes(label) ||
        candidate.getAttribute("aria-label")?.includes(label),
    ) ??
    Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find(
      (candidate) =>
        candidate.textContent?.includes(label) ||
        candidate.getAttribute("aria-label")?.includes(label),
    );
  if (target === undefined) {
    throw new Error(`Missing button: ${label}`);
  }
  act(() => {
    target.click();
  });
}

function clickMenuItem(label: string): void {
  const target = Array.from(
    container.querySelectorAll<HTMLButtonElement>('[role="menu"] button'),
  ).find((candidate) => candidate.textContent?.trim().includes(label));
  if (target === undefined) {
    throw new Error(`Missing menu item: ${label}`);
  }
  act(() => {
    target.click();
  });
}

function documentDriveEntry(input: {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly deletedAt?: string | null;
}) {
  return {
    id: input.id,
    type: "file",
    name: input.name,
    folderId: null,
    ownerActorId: "11111111-1111-4111-8111-111111111111",
    ownerDisplayName: "You",
    app: null,
    mimeType: input.mimeType,
    metadata: {},
    deletedAt: input.deletedAt ?? null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
  };
}
