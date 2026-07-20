// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriveShell } from "./drive-shell";
import type { DriveApiEntry } from "./api";
import { HELIX_DRIVE_ITEM_DRAG_MIME } from "./drag-payload";

// Mock @tanstack/react-router so DriveShell can call router hooks without a router context.
const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {} as Record<string, unknown>,
}));
const navigateMock = routerMocks.navigate;
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  useSearch: () => routerMocks.search,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** The first selectable file card/row — `aria-pressed` buttons that are not
 *  the `.btn`-classed grid/list toggle buttons. */
function firstFileCard(container: HTMLElement): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")).find(
      (button) => !button.classList.contains("btn") && !button.classList.contains("icon-btn"),
    ) ?? null
  );
}

function fileButton(container: HTMLElement, name: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")).find(
      (button) =>
        !button.classList.contains("btn") &&
        !button.classList.contains("icon-btn") &&
        button.textContent?.includes(name),
    ) ?? null
  );
}

function entry(
  overrides: Partial<DriveApiEntry> & Pick<DriveApiEntry, "id" | "type" | "name">,
): DriveApiEntry {
  return {
    folderId: null,
    ownerActorId: "owner-1",
    metadata: {},
    deletedAt: null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
    ...overrides,
  };
}

const ROOT_ENTRIES: readonly DriveApiEntry[] = [
  entry({ id: "folder-eng", type: "folder", name: "Engineering" }),
  entry({
    id: "file-specs",
    type: "file",
    name: "Specs.pdf",
    mimeType: "application/pdf",
    byteSize: 1024,
  }),
  entry({
    id: "file-roadmap",
    type: "file",
    name: "Roadmap.docx",
    mimeType: "application/msword",
    byteSize: 2048,
  }),
  entry({
    id: "file-budget",
    type: "file",
    name: "Budget.xlsx",
    mimeType: "application/vnd.ms-excel",
    byteSize: 4096,
  }),
];

const FOLDER_CHILDREN: readonly DriveApiEntry[] = [
  entry({
    id: "file-nested",
    type: "file",
    name: "Nested-spec.pdf",
    folderId: "folder-eng",
    mimeType: "application/pdf",
  }),
];

describe("DriveShell", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let toolCalls: Array<{ url: string; body: unknown }>;

  beforeEach(() => {
    navigateMock.mockClear();
    routerMocks.search = {};
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    toolCalls = [];
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
      if (url !== "/api/auth/get-session") {
        toolCalls.push({ url, body });
      }

      if (url === "/api/auth/get-session") {
        return Promise.resolve(
          Response.json({
            user: {
              id: "session-user",
              email: "owner@helix.local",
              name: "Owner One",
              actorId: "owner-1",
            },
          }),
        );
      }
      if (url === "/api/tools/drive.list") {
        const folderId = (body as { folderId?: string | null }).folderId ?? null;
        const entries = folderId === "folder-eng" ? FOLDER_CHILDREN : ROOT_ENTRIES;
        return Promise.resolve(Response.json({ entries }));
      }
      if (url === "/api/tools/drive.search") {
        return Promise.resolve(Response.json({ hits: [] }));
      }
      if (url === "/api/tools/drive.trash") {
        return Promise.resolve(Response.json({ id: "file-roadmap", deletedAt: "now" }));
      }
      if (url === "/api/tools/drive.access.list") {
        return Promise.resolve(
          Response.json({
            grants: [
              {
                actorId: "66666666-6666-4666-8666-666666666666",
                role: "reader",
                displayName: "Maya Chen",
                email: "maya@helix.local",
                grantedByActorId: "owner-1",
                expiresAt: null,
                createdAt: "2026-05-20T12:00:00.000Z",
                updatedAt: "2026-05-20T12:00:00.000Z",
              },
            ],
          }),
        );
      }
      if (url === "/api/tools/drive.access.remove") {
        return Promise.resolve(
          Response.json({
            objectId: (body as { objectId?: string }).objectId,
            actorId: (body as { actorId?: string }).actorId,
            removed: true,
          }),
        );
      }
      if (url === "/api/tools/drive.access.update") {
        return Promise.resolve(
          Response.json({
            objectId: (body as { objectId?: string }).objectId,
            actorId: (body as { actorId?: string }).actorId,
            grant: {
              actorId: (body as { actorId?: string }).actorId,
              role: (body as { role?: string }).role,
              displayName: "Maya Chen",
              email: "maya@helix.local",
              grantedByActorId: "owner-1",
              expiresAt: null,
              createdAt: "2026-05-20T12:00:00.000Z",
              updatedAt: "2026-05-20T12:01:00.000Z",
            },
          }),
        );
      }
      if (url === "/api/tools/drive.star.set") {
        return Promise.resolve(
          Response.json({
            id: (body as { objectId?: string }).objectId,
            metadata: { starred: (body as { starred?: boolean }).starred },
          }),
        );
      }
      return Promise.resolve(Response.json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  function render() {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <DriveShell />
        </QueryClientProvider>,
      );
    });
  }

  async function settle() {
    for (let i = 0; i < 30; i += 1) {
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    }
  }

  function clickControl(label: string): void {
    const target = [...container.querySelectorAll<HTMLElement>("button,[role='button']")].find(
      (control) =>
        control.textContent?.includes(label) === true ||
        control.getAttribute("aria-label")?.includes(label) === true,
    );
    if (target === undefined) {
      throw new Error(`Missing control: ${label}`);
    }
    act(() => {
      target.click();
    });
  }

  function setInputValue(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (setter === undefined) {
      throw new Error("native input value setter unavailable");
    }
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function setSelectValue(select: HTMLSelectElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
    if (setter === undefined) {
      throw new Error("native select value setter unavailable");
    }
    act(() => {
      setter.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("renders backend folders and files from drive.list", async () => {
    render();
    await settle();

    const text = container.textContent ?? "";
    expect(text).toContain("Engineering");
    expect(text).toContain("Roadmap.docx");
    expect(toolCalls.some((call) => call.url === "/api/tools/drive.list")).toBe(true);
  });

  it("uses the Drive URL query to run backend search instead of the folder list", async () => {
    routerMocks.search = { q: "budget" };

    render();
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.search")?.body).toEqual({
      query: "budget",
      folderId: null,
      limit: 51,
    });
    expect(toolCalls.some((call) => call.url === "/api/tools/drive.list")).toBe(false);
  });

  it("lets large Drive folders request the next backend page size", async () => {
    const largeEntries = Array.from({ length: 101 }, (_, index) =>
      entry({
        id: `file-${String(index).padStart(3, "0")}`,
        type: "file",
        name: `Large file ${String(index).padStart(3, "0")}.pdf`,
        mimeType: "application/pdf",
        byteSize: 1024,
      }),
    );
    fetchMock.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (url !== "/api/auth/get-session") {
        toolCalls.push({ url, body });
      }
      if (url === "/api/auth/get-session") {
        return Promise.resolve(
          Response.json({
            user: { id: "session-user", email: "owner@helix.local", name: "Owner One", actorId: "owner-1" },
          }),
        );
      }
      if (url === "/api/tools/drive.list") {
        return Promise.resolve(Response.json({ entries: largeEntries }));
      }
      return Promise.resolve(Response.json({}));
    });

    render();
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.list")?.body).toMatchObject({
      limit: 101,
    });
    clickControl("Show more");
    await settle();

    expect(
      toolCalls.filter((call) => call.url === "/api/tools/drive.list").at(-1)?.body,
    ).toMatchObject({ limit: 201 });
  });

  it("stars files through the Drive star tool", async () => {
    render();
    await settle();

    clickControl("Star Specs.pdf");
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.star.set")?.body).toEqual({
      objectId: "file-specs",
      starred: true,
    });
  });

  it("navigates into a folder and updates the breadcrumb", async () => {
    render();
    await settle();

    const folderButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Engineering"),
    );
    expect(folderButton).not.toBeNull();
    act(() => {
      folderButton?.click();
    });
    await settle();

    // The folder's children loaded via a scoped drive.list call.
    expect(
      toolCalls.some(
        (call) =>
          call.url === "/api/tools/drive.list" &&
          (call.body as { folderId?: string }).folderId === "folder-eng",
      ),
    ).toBe(true);
    expect(container.textContent ?? "").toContain("Nested-spec.pdf");

    // Breadcrumb shows the folder and the clickable scope root.
    const crumb = container.querySelector('nav[aria-label="Drive breadcrumb"]');
    expect(crumb?.textContent ?? "").toContain("Engineering");
    expect(crumb?.textContent ?? "").toContain("My Drive");

    // Clicking the root crumb returns to My Drive.
    const rootCrumb = Array.from(crumb?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (button) => button.textContent?.trim() === "My Drive",
    );
    act(() => {
      rootCrumb?.click();
    });
    await settle();
    expect(container.textContent ?? "").toContain("Roadmap.docx");
  });

  it("opens the details panel with real entry data when a file card is clicked", async () => {
    render();
    await settle();

    const fileCard = firstFileCard(container);
    expect(fileCard).not.toBeNull();
    act(() => {
      fileCard?.click();
    });

    const panel = container.querySelector('aside[aria-label="File details"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent ?? "").toContain("Recent activity");
    expect(panel?.textContent ?? "").toContain("Owner");
  });

  it("shares from the details panel by email/name refs and actor ids", async () => {
    render();
    await settle();

    const fileCard = firstFileCard(container);
    expect(fileCard).not.toBeNull();
    act(() => {
      fileCard?.click();
    });
    await settle();

    const input = container.querySelector<HTMLInputElement>(
      'aside[aria-label="File details"] input[placeholder="Email, name, or actor ID"]',
    );
    expect(input).not.toBeNull();
    setInputValue(
      input!,
      "maya@helix.local 66666666-6666-4666-8666-666666666666 Maya",
    );
    const shareRole = container.querySelector<HTMLSelectElement>(
      'aside[aria-label="File details"] select[aria-label="Share role"]',
    );
    expect(shareRole).not.toBeNull();
    setSelectValue(shareRole!, "commenter");
    const shareButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('aside[aria-label="File details"] button'),
    ).find((button) => button.textContent?.trim() === "Share");
    expect(shareButton).not.toBeNull();
    act(() => {
      shareButton?.click();
    });
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.share")?.body).toEqual({
      objectId: "file-specs",
      actorIds: ["66666666-6666-4666-8666-666666666666"],
      actorRefs: ["maya@helix.local", "Maya"],
      role: "commenter",
      expiresAt: null,
    });
    expect(container.textContent ?? "").toContain("People with access");
    expect(container.textContent ?? "").toContain("Maya Chen");
  });

  it("removes Drive access grants from the details panel", async () => {
    render();
    await settle();

    const fileCard = firstFileCard(container);
    expect(fileCard).not.toBeNull();
    act(() => {
      fileCard?.click();
    });
    await settle();

    clickControl("Remove access for Maya Chen");
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.access.remove")?.body).toEqual({
      objectId: "file-specs",
      actorId: "66666666-6666-4666-8666-666666666666",
    });
  });

  it("updates Drive access grant roles from the details panel", async () => {
    render();
    await settle();

    const fileCard = firstFileCard(container);
    expect(fileCard).not.toBeNull();
    act(() => {
      fileCard?.click();
    });
    await settle();

    const roleSelect = container.querySelector<HTMLSelectElement>(
      'aside[aria-label="File details"] select[aria-label="Access role for Maya Chen"]',
    );
    expect(roleSelect).not.toBeNull();
    setSelectValue(roleSelect!, "editor");
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.access.update")?.body).toEqual({
      objectId: "file-specs",
      actorId: "66666666-6666-4666-8666-666666666666",
      role: "editor",
      expiresAt: null,
    });
  });

  it("makes Drive file cards draggable with internal open payloads", async () => {
    render();
    await settle();

    const roadmapCard = fileButton(container, "Roadmap.docx");
    expect(roadmapCard).not.toBeNull();
    expect(roadmapCard?.draggable).toBe(true);

    const data = new Map<string, string>();
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "uninitialized",
      setData: vi.fn((type: string, value: string) => {
        data.set(type, value);
      }),
    };
    act(() => {
      const event = new Event("dragstart", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      roadmapCard?.dispatchEvent(event);
    });

    const expectedHref = new URL("/open/file-roadmap", window.location.origin).href;
    expect(data.get("text/uri-list")).toBe(expectedHref);
    expect(data.get("text/plain")).toBe("Roadmap.docx");
    expect(data.get(HELIX_DRIVE_ITEM_DRAG_MIME)).toContain('"id":"file-roadmap"');
    expect(data.get(HELIX_DRIVE_ITEM_DRAG_MIME)).toContain(`"href":"${expectedHref}"`);
  });

  it("asks before creating an editable copy from a foreign document", async () => {
    render();
    await settle();

    const docxButton = fileButton(container, "Roadmap.docx");
    expect(docxButton).not.toBeNull();
    act(() => {
      docxButton?.click();
    });
    await settle();

    expect(navigateMock).not.toHaveBeenCalled();
    expect(container.querySelector('aside[aria-label="File details"]')).toBeNull();
    expect(document.body.textContent ?? "").toContain("Create editable copy?");
    expect(document.body.textContent ?? "").toContain("Roadmap.docx");
    expect(toolCalls.some((call) => call.url.includes("docs.import"))).toBe(false);
  });

  it("does not offer Create copy for previewable formats without a native converter", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (url !== "/api/auth/get-session") {
        toolCalls.push({ url, body });
      }
      if (url === "/api/auth/get-session") {
        return Promise.resolve(Response.json({}));
      }
      if (url === "/api/tools/drive.list") {
        return Promise.resolve(
          Response.json({
            entries: [
              entry({
                id: "file-planning-odp",
                type: "file",
                name: "Planning deck.odp",
                mimeType: "application/vnd.oasis.opendocument.presentation",
              }),
            ],
          }),
        );
      }
      if (url === "/api/tools/drive.search") {
        return Promise.resolve(Response.json({ hits: [] }));
      }
      return Promise.resolve(Response.json({}));
    });

    render();
    await settle();

    const odpButton = fileButton(container, "Planning deck.odp");
    expect(odpButton).not.toBeNull();
    act(() => {
      odpButton?.click();
    });
    await settle();

    expect(document.body.textContent ?? "").toContain("Preview/download only");
    expect(document.body.textContent ?? "").toContain("Planning deck.odp");
    expect(document.body.textContent ?? "").toContain("editable conversion for ODP");
    expect(
      Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).some(
        (button) => button.textContent?.trim() === "Create copy",
      ),
    ).toBe(false);
    expect(toolCalls.some((call) => call.url.includes("slides.import"))).toBe(false);
  });

  it("uses the same copy decision from the details panel Open button", async () => {
    render();
    await settle();

    const docxButton = fileButton(container, "Roadmap.docx");
    act(() => {
      docxButton?.click();
    });
    await settle();

    const previewOnly = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "Preview only");
    expect(previewOnly).not.toBeNull();
    act(() => {
      previewOnly?.click();
    });
    await settle();

    const panel = container.querySelector('aside[aria-label="File details"]');
    expect(panel).not.toBeNull();
    const openButton = Array.from(panel?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (button) => button.textContent?.trim() === "Open",
    );
    expect(openButton).not.toBeNull();
    act(() => {
      openButton?.click();
    });
    await settle();

    expect(navigateMock).not.toHaveBeenCalled();
    expect(document.body.textContent ?? "").toContain("Create editable copy?");
    expect(document.body.textContent ?? "").toContain("Roadmap.docx");
  });

  it("trashes a file via the drive.trash tool", async () => {
    render();
    await settle();

    act(() => {
      firstFileCard(container)?.click();
    });
    const trashButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Move to trash",
    );
    expect(trashButton).not.toBeNull();
    act(() => {
      trashButton?.click();
    });
    await settle();

    expect(toolCalls.some((call) => call.url === "/api/tools/drive.trash")).toBe(true);
  });

  it("switches the active scope in the sidebar", async () => {
    render();
    await settle();

    const sharedButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Shared with me",
    );
    expect(sharedButton).not.toBeNull();
    act(() => {
      sharedButton?.click();
    });
    await settle();
    expect(sharedButton?.getAttribute("aria-current")).toBe("page");
    expect(
      toolCalls.some(
        (call) =>
          call.url === "/api/tools/drive.list" &&
          (call.body as { acrossFolders?: boolean }).acrossFolders === true,
      ),
    ).toBe(true);
  });

  it("surfaces a clean error state when the backend listing errors", async () => {
    fetchMock.mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "/api/auth/get-session") {
        return Promise.resolve(Response.json({}));
      }
      return Promise.resolve(Response.json({ error: "drive unavailable" }, { status: 503 }));
    });
    render();
    await settle();

    const text = container.textContent ?? "";
    // No fabricated rows leak through — the shell just renders the empty
    // folder/file lists. The breadcrumb still anchors the layout.
    expect(text).not.toContain("Roadmap.docx");
    expect(text).not.toContain("Engineering");
  });

  describe("app-typed file entries open their editor", () => {
    function makeAppEntries(): readonly DriveApiEntry[] {
      return [
        entry({ id: "doc-entry-1", type: "file", name: "My Doc", app: "docs" }),
        entry({ id: "sheet-entry-1", type: "file", name: "My Sheet", app: "sheets" }),
        entry({ id: "deck-entry-1", type: "file", name: "My Deck", app: "slides" }),
        entry({ id: "plain-file-1", type: "file", name: "Plain.pdf", mimeType: "application/pdf" }),
      ];
    }

    function setupFetch(entries: readonly DriveApiEntry[]) {
      fetchMock.mockImplementation((input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        if (url !== "/api/auth/get-session") {
          toolCalls.push({ url, body });
        }
        if (url === "/api/auth/get-session") {
          return Promise.resolve(Response.json({}));
        }
        if (url === "/api/tools/drive.list") {
          return Promise.resolve(Response.json({ entries }));
        }
        return Promise.resolve(Response.json({}));
      });
    }

    function findFileButton(name: string): HTMLButtonElement | null {
      return (
        Array.from(container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")).find(
          (button) => button.textContent?.includes(name),
        ) ?? null
      );
    }

    it("clicking a docs entry navigates to the native document route", async () => {
      setupFetch(makeAppEntries());
      render();
      await settle();

      const docButton = findFileButton("My Doc");
      expect(docButton).not.toBeNull();
      act(() => {
        docButton?.click();
      });

      expect(navigateMock).toHaveBeenCalledWith({
        to: "/docs/$documentId",
        params: { documentId: "doc-entry-1" },
      });
    });

    it("clicking a sheets entry navigates to /sheets with ?sheet=<id>", async () => {
      setupFetch(makeAppEntries());
      render();
      await settle();

      const sheetButton = findFileButton("My Sheet");
      expect(sheetButton).not.toBeNull();
      act(() => {
        sheetButton?.click();
      });

      expect(navigateMock).toHaveBeenCalledWith({
        to: "/sheets",
        search: { sheet: "sheet-entry-1" },
      });
    });

    it("clicking a slides entry navigates to /slides with ?deck=<id>", async () => {
      setupFetch(makeAppEntries());
      render();
      await settle();

      const deckButton = findFileButton("My Deck");
      expect(deckButton).not.toBeNull();
      act(() => {
        deckButton?.click();
      });

      expect(navigateMock).toHaveBeenCalledWith({
        to: "/slides",
        search: { deck: "deck-entry-1" },
      });
    });

    it("clicking a plain file (no app) opens the details panel instead of navigating", async () => {
      setupFetch(makeAppEntries());
      render();
      await settle();

      const plainButton = findFileButton("Plain.pdf");
      expect(plainButton).not.toBeNull();
      act(() => {
        plainButton?.click();
      });

      // No navigation should happen
      expect(navigateMock).not.toHaveBeenCalled();
      // Details panel should be open
      const panel = container.querySelector('aside[aria-label="File details"]');
      expect(panel).not.toBeNull();
    });
  });

  describe("New dropdown", () => {
    it('clicking "New" opens a menu with the expected items', async () => {
      render();
      await settle();

      // Find and click the "New" button in the sidebar.
      const newButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "New",
      );
      expect(newButton).not.toBeNull();

      act(() => {
        newButton?.click();
      });

      // The dropdown menu should now be visible in the document.
      const menuText = document.body.textContent ?? "";
      expect(menuText).toContain("New folder");
      expect(menuText).toContain("Document");
      expect(menuText).toContain("Spreadsheet");
      expect(menuText).toContain("Presentation");
      expect(menuText).toContain("Upload file");
    });

    it('clicking "Document" fires POST /api/tools/drive.create with kind:"document" and current folderId', async () => {
      // Mock drive.create to return { id, app } for a document.
      fetchMock.mockImplementation((input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        if (url !== "/api/auth/get-session") {
          toolCalls.push({ url, body });
        }
        if (url === "/api/auth/get-session") {
          return Promise.resolve(Response.json({}));
        }
        if (url === "/api/tools/drive.list") {
          return Promise.resolve(Response.json({ entries: ROOT_ENTRIES }));
        }
        if (url === "/api/tools/drive.create") {
          return Promise.resolve(Response.json({ id: "new-doc-id", app: "docs" }));
        }
        return Promise.resolve(Response.json({}));
      });

      render();
      await settle();

      // Open the "New" dropdown.
      const newButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "New",
      );
      act(() => {
        newButton?.click();
      });

      // Click "Document" in the menu.
      const documentItem = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.trim() === "Document");
      expect(documentItem).not.toBeNull();
      act(() => {
        documentItem?.click();
      });
      await settle();

      // Verify the drive.create call was made with the correct payload.
      const createCall = toolCalls.find((call) => call.url === "/api/tools/drive.create");
      expect(createCall).not.toBeUndefined();
      expect(createCall?.body).toMatchObject({
        kind: "document",
        folderId: null,
      });
      // The name should be a non-empty string.
      expect(typeof (createCall?.body as { name?: string }).name).toBe("string");
      expect((createCall?.body as { name?: string }).name?.length).toBeGreaterThan(0);

      // The new document's editor must open in the native document route.
      expect(navigateMock).toHaveBeenCalledWith({
        to: "/docs/$documentId",
        params: { documentId: "new-doc-id" },
      });
    });

    it('clicking "New folder" fires POST /api/tools/drive.create with kind:"folder"', async () => {
      fetchMock.mockImplementation((input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        if (url !== "/api/auth/get-session") {
          toolCalls.push({ url, body });
        }
        if (url === "/api/auth/get-session") {
          return Promise.resolve(Response.json({}));
        }
        if (url === "/api/tools/drive.list") {
          return Promise.resolve(Response.json({ entries: ROOT_ENTRIES }));
        }
        if (url === "/api/tools/drive.create") {
          return Promise.resolve(
            Response.json({ id: "new-folder-id", type: "folder", name: "New folder" }),
          );
        }
        return Promise.resolve(Response.json({}));
      });

      render();
      await settle();

      const newButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "New",
      );
      act(() => {
        newButton?.click();
      });

      const folderItem = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.trim() === "New folder");
      expect(folderItem).not.toBeNull();
      act(() => {
        folderItem?.click();
      });
      await settle();

      const createCall = toolCalls.find((call) => call.url === "/api/tools/drive.create");
      expect(createCall).not.toBeUndefined();
      expect(createCall?.body).toMatchObject({ kind: "folder", folderId: null });
    });
  });

  describe("drag-and-drop upload", () => {
    /** Build a minimal DataTransfer-like object for drop events. */
    function makeDataTransfer(files: File[]): DataTransfer {
      const fileListLike = Object.assign(files, {
        item: (i: number) => files[i] ?? null,
      }) as unknown as FileList;
      const itemsLike = [] as unknown as DataTransferItemList;
      return {
        files: fileListLike,
        items: itemsLike,
        types: ["Files"],
        dropEffect: "copy",
        effectAllowed: "all",
        clearData: () => undefined,
        getData: () => "",
        setData: () => undefined,
        setDragImage: () => undefined,
      };
    }

    function fireDragEvent(element: Element, type: string, dataTransfer?: DataTransfer) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      if (dataTransfer !== undefined) {
        Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      }
      element.dispatchEvent(event);
    }

    it("shows the drop overlay when files are dragged over the main area", async () => {
      render();
      await settle();

      const main = container.querySelector<HTMLDivElement>('[data-testid="drive-main"]');
      expect(main).not.toBeNull();

      // No overlay before drag
      expect(container.querySelector('[data-testid="drive-drop-overlay"]')).toBeNull();

      act(() => {
        fireDragEvent(main!, "dragenter", makeDataTransfer([]));
      });

      expect(container.querySelector('[data-testid="drive-drop-overlay"]')).not.toBeNull();

      // After dragleave the overlay disappears
      act(() => {
        fireDragEvent(main!, "dragleave", makeDataTransfer([]));
      });
      expect(container.querySelector('[data-testid="drive-drop-overlay"]')).toBeNull();
    });

    it("calls uploadDriveFile for each dropped file with the current folderId", async () => {
      // Stub crypto.subtle.digest (not available in jsdom)
      const digestSpy = vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));

      fetchMock.mockImplementation((input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        if (url !== "/api/auth/get-session") {
          toolCalls.push({ url, body });
        }
        if (url === "/api/auth/get-session") {
          return Promise.resolve(Response.json({}));
        }
        if (url === "/api/tools/drive.list") {
          return Promise.resolve(Response.json({ entries: ROOT_ENTRIES }));
        }
        if (url === "/api/tools/drive.upload") {
          return Promise.resolve(
            Response.json({
              objectId: "new-obj",
              orgId: "org-1",
              ownerActorId: "actor-1",
              name: "test.txt",
              folderId: null,
              storageKey: "drive/test.txt",
              mimeType: "text/plain",
              byteSize: 4,
              sha256: "a".repeat(64),
              status: "prepared",
              uploadUrl: null,
              uploadHeaders: {},
              metadata: {},
              createdAt: "2026-05-21T00:00:00.000Z",
              updatedAt: "2026-05-21T00:00:00.000Z",
            }),
          );
        }
        if (url === "/api/tools/drive.finalize") {
          return Promise.resolve(
            Response.json({
              id: "ver-1",
              orgId: "org-1",
              objectId: "new-obj",
              versionNumber: 1,
              storageKey: "drive/test.txt",
              mimeType: "text/plain",
              byteSize: 4,
              sha256: "a".repeat(64),
              metadata: {},
              createdByActorId: "actor-1",
              createdAt: "2026-05-21T00:00:00.000Z",
            }),
          );
        }
        return Promise.resolve(Response.json({}));
      });

      render();
      await settle();

      const main = container.querySelector<HTMLDivElement>('[data-testid="drive-main"]');
      expect(main).not.toBeNull();

      const file1 = new File(["test"], "file1.txt", { type: "text/plain" });
      const file2 = new File(["data"], "file2.txt", { type: "text/plain" });
      const dt = makeDataTransfer([file1, file2]);

      act(() => {
        fireDragEvent(main!, "dragenter", dt);
      });
      act(() => {
        fireDragEvent(main!, "drop", dt);
      });
      await settle();

      // Both files should have triggered drive.upload calls
      const uploadCalls = toolCalls.filter((c) => c.url === "/api/tools/drive.upload");
      expect(uploadCalls.length).toBe(2);
      // Both should target the root folderId (null) since we're at the root
      for (const call of uploadCalls) {
        expect((call.body as { folderId: unknown }).folderId).toBeNull();
      }

      digestSpy.mockRestore();
    });

    it("uploads dropped editable files as raw Drive objects and opens the explicit copy flow", async () => {
      const digestSpy = vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
      const uploadedIds = new Map<string, string>();

      fetchMock.mockImplementation((input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        if (url !== "/api/auth/get-session") {
          toolCalls.push({ url, body });
        }
        if (url === "/api/auth/get-session") {
          return Promise.resolve(Response.json({}));
        }
        if (url === "/api/tools/drive.list") {
          return Promise.resolve(Response.json({ entries: ROOT_ENTRIES }));
        }
        if (url === "/api/tools/drive.upload") {
          const name = (body as { name?: string }).name ?? "upload.bin";
          const objectId = `uploaded-${name
            .toLowerCase()
            .replace(/[^a-z0-9]+/gu, "-")
            .replace(/^-|-$/gu, "")}`;
          uploadedIds.set(name, objectId);
          return Promise.resolve(
            Response.json({
              objectId,
              orgId: "org-1",
              ownerActorId: "actor-1",
              name,
              folderId: null,
              storageKey: `drive/${name}`,
              mimeType: (body as { mimeType?: string }).mimeType ?? "application/octet-stream",
              byteSize: (body as { byteSize?: number }).byteSize ?? 0,
              sha256: "a".repeat(64),
              status: "prepared",
              uploadUrl: null,
              uploadHeaders: {},
              metadata: {},
              createdAt: "2026-05-21T00:00:00.000Z",
              updatedAt: "2026-05-21T00:00:00.000Z",
            }),
          );
        }
        if (url === "/api/tools/drive.finalize") {
          return Promise.resolve(
            Response.json({
              id: "ver-1",
              orgId: "org-1",
              objectId: (body as { objectId?: string }).objectId ?? "uploaded",
              versionNumber: 1,
              storageKey: (body as { storageKey?: string }).storageKey ?? "drive/uploaded",
              mimeType: (body as { mimeType?: string }).mimeType ?? "application/octet-stream",
              byteSize: (body as { byteSize?: number }).byteSize ?? 0,
              sha256: "a".repeat(64),
              metadata: {},
              createdByActorId: "actor-1",
              createdAt: "2026-05-21T00:00:00.000Z",
            }),
          );
        }
        return Promise.resolve(Response.json({}));
      });

      render();
      await settle();

      const main = container.querySelector<HTMLDivElement>('[data-testid="drive-main"]');
      expect(main).not.toBeNull();

      const files = [
        new File(["Customer,ARR\nAcme,1200"], "Renewals.csv", { type: "text/csv" }),
        new File([Uint8Array.from([1, 2, 3])], "Forecast.xlsx", {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
        new File([Uint8Array.from([4, 5, 6])], "Forecast.ods", {
          type: "application/vnd.oasis.opendocument.spreadsheet",
        }),
        new File([Uint8Array.from([4, 5, 6])], "Launch plan.docx", {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
        new File([Uint8Array.from([7, 8, 9])], "Board narrative.pptx", {
          type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        }),
        new File([Uint8Array.from([10, 11, 12])], "Legacy deck.ppt", {
          type: "application/vnd.ms-powerpoint",
        }),
        new File(["Customer\tStage\nAcme\tCommit"], "Pipeline.tsv", {
          type: "text/tab-separated-values",
        }),
      ];

      for (const file of files) {
        navigateMock.mockClear();
        act(() => {
          fireDragEvent(main!, "drop", makeDataTransfer([file]));
        });
        await settle();

        const objectId = uploadedIds.get(file.name);
        expect(objectId).toBeDefined();
        expect(navigateMock).toHaveBeenCalledWith({
          to: "/open/$objectId",
          params: { objectId },
        });
      }

      expect(toolCalls.some((call) => call.url.includes(".import-"))).toBe(false);
      expect(toolCalls.filter((call) => call.url === "/api/tools/drive.upload")).toHaveLength(
        files.length,
      );
      expect(toolCalls.filter((call) => call.url === "/api/tools/drive.finalize")).toHaveLength(
        files.length,
      );

      digestSpy.mockRestore();
    });
  });

  describe("FAB (floating action button)", () => {
    it("renders the FAB in the drive main area", async () => {
      render();
      await settle();

      const fab = container.querySelector<HTMLButtonElement>('[data-testid="drive-fab"]');
      expect(fab).not.toBeNull();
      expect(fab?.getAttribute("aria-label")).toBe("New");
    });

    it("clicking the FAB opens a menu with the same items as the sidebar New button", async () => {
      render();
      await settle();

      const fab = container.querySelector<HTMLButtonElement>('[data-testid="drive-fab"]');
      expect(fab).not.toBeNull();

      // Menu not shown initially
      expect(container.querySelector('[data-testid="drive-fab-menu"]')).toBeNull();

      act(() => {
        fab?.click();
      });

      const menu = container.querySelector('[data-testid="drive-fab-menu"]');
      expect(menu).not.toBeNull();
      const menuText = menu?.textContent ?? "";
      expect(menuText).toContain("New folder");
      expect(menuText).toContain("Document");
      expect(menuText).toContain("Spreadsheet");
      expect(menuText).toContain("Presentation");
      expect(menuText).toContain("Upload file");
    });

    it("clicking a FAB menu item (Document) fires drive.create with kind:document", async () => {
      fetchMock.mockImplementation((input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        if (url !== "/api/auth/get-session") {
          toolCalls.push({ url, body });
        }
        if (url === "/api/auth/get-session") {
          return Promise.resolve(Response.json({}));
        }
        if (url === "/api/tools/drive.list") {
          return Promise.resolve(Response.json({ entries: ROOT_ENTRIES }));
        }
        if (url === "/api/tools/drive.create") {
          return Promise.resolve(Response.json({ id: "doc-fab-id", app: "docs" }));
        }
        return Promise.resolve(Response.json({}));
      });

      render();
      await settle();

      const fab = container.querySelector<HTMLButtonElement>('[data-testid="drive-fab"]');
      act(() => {
        fab?.click();
      });

      const documentItem = Array.from(
        container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
      ).find((btn) => btn.textContent?.trim() === "Document");
      expect(documentItem).not.toBeNull();

      act(() => {
        documentItem?.click();
      });
      await settle();

      const createCall = toolCalls.find((c) => c.url === "/api/tools/drive.create");
      expect(createCall).not.toBeUndefined();
      expect(createCall?.body).toMatchObject({ kind: "document", folderId: null });

      // Menu closes after selection
      expect(container.querySelector('[data-testid="drive-fab-menu"]')).toBeNull();

      // Should navigate to the new doc's editor
      expect(navigateMock).toHaveBeenCalledWith({
        to: "/docs/$documentId",
        params: { documentId: "doc-fab-id" },
      });
    });

    it("FAB menu closes when escape is pressed", async () => {
      render();
      await settle();

      const fab = container.querySelector<HTMLButtonElement>('[data-testid="drive-fab"]');
      act(() => {
        fab?.click();
      });
      expect(container.querySelector('[data-testid="drive-fab-menu"]')).not.toBeNull();

      const menu = container.querySelector<HTMLDivElement>('[data-testid="drive-fab-menu"]');
      act(() => {
        const escEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
        menu?.dispatchEvent(escEvent);
      });
      expect(container.querySelector('[data-testid="drive-fab-menu"]')).toBeNull();
    });
  });
});
