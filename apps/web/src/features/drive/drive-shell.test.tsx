// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriveShell } from "./drive-shell";
import { DRIVE_FILES_SEED, DRIVE_FOLDERS_SEED } from "./drive-data";
import type { DriveApiEntry } from "./api";

// Mock @tanstack/react-router so DriveShell can call useNavigate without a router context.
const navigateMock = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateMock }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** The first selectable file card/row — `aria-pressed` buttons that are not
 *  the `.btn`-classed grid/list toggle buttons. */
function firstFileCard(container: HTMLElement): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")).find(
      (button) => !button.classList.contains("btn"),
    ) ?? null
  );
}

function entry(overrides: Partial<DriveApiEntry> & Pick<DriveApiEntry, "id" | "type" | "name">): DriveApiEntry {
  return {
    folderId: null,
    ownerActorId: "owner-1",
    deletedAt: null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
    ...overrides,
  };
}

const ROOT_ENTRIES: readonly DriveApiEntry[] = [
  entry({ id: "folder-eng", type: "folder", name: "Engineering" }),
  entry({ id: "file-roadmap", type: "file", name: "Roadmap.docx", mimeType: "application/msword", byteSize: 2048 }),
  entry({ id: "file-budget", type: "file", name: "Budget.xlsx", mimeType: "application/vnd.ms-excel", byteSize: 4096 }),
];

const FOLDER_CHILDREN: readonly DriveApiEntry[] = [
  entry({ id: "file-nested", type: "file", name: "Nested-spec.pdf", folderId: "folder-eng", mimeType: "application/pdf" }),
];

describe("DriveShell", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let toolCalls: Array<{ url: string; body: unknown }>;

  beforeEach(() => {
    navigateMock.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    toolCalls = [];
    fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body: unknown =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (url !== "/api/auth/get-session") {
        toolCalls.push({ url, body });
      }

      if (url === "/api/auth/get-session") {
        return Promise.resolve(Response.json({}));
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

  it("renders backend folders and files from drive.list", async () => {
    render();
    await settle();

    const text = container.textContent ?? "";
    expect(text).toContain("Engineering");
    expect(text).toContain("Roadmap.docx");
    expect(text).toContain("2.4 TB of 5 TB used");
    expect(toolCalls.some((call) => call.url === "/api/tools/drive.list")).toBe(true);
  });

  it("navigates into a folder and updates the breadcrumb", async () => {
    render();
    await settle();

    const folderButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("Engineering"));
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
    const rootCrumb = Array.from(
      crumb?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((button) => button.textContent?.trim() === "My Drive");
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

  it("trashes a file via the drive.trash tool", async () => {
    render();
    await settle();

    act(() => {
      firstFileCard(container)?.click();
    });
    const trashButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "Move to trash");
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

    const sharedButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "Shared with me");
    expect(sharedButton).not.toBeNull();
    act(() => {
      sharedButton?.click();
    });
    await settle();
    expect(sharedButton?.getAttribute("aria-current")).toBe("page");
    // Non-folder scopes ride drive.search.
    expect(toolCalls.some((call) => call.url === "/api/tools/drive.search")).toBe(true);
  });

  it("falls back to the typed seed when the backend listing errors", async () => {
    fetchMock.mockImplementation((input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "/api/auth/get-session") {
        return Promise.resolve(Response.json({}));
      }
      return Promise.resolve(Response.json({ error: "drive unavailable" }, { status: 503 }));
    });
    render();
    await settle();

    const text = container.textContent ?? "";
    expect(text).toContain(DRIVE_FOLDERS_SEED[0]?.name ?? "");
    expect(text).toContain(DRIVE_FILES_SEED[0]?.name ?? "");
  });

  describe("New dropdown", () => {
    it('clicking "New" opens a menu with the expected items', async () => {
      render();
      await settle();

      // Find and click the "New" button in the sidebar.
      const newButton = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.trim() === "New");
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
        const body: unknown =
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
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
      const newButton = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.trim() === "New");
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

      // The new document's editor must open: navigate to /docs threading the
      // created id through the `doc` search param.
      expect(navigateMock).toHaveBeenCalledWith({
        to: "/docs",
        search: { doc: "new-doc-id" },
      });
    });

    it('clicking "New folder" fires POST /api/tools/drive.create with kind:"folder"', async () => {
      fetchMock.mockImplementation((input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body: unknown =
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
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
          return Promise.resolve(Response.json({ id: "new-folder-id", type: "folder", name: "New folder" }));
        }
        return Promise.resolve(Response.json({}));
      });

      render();
      await settle();

      const newButton = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.trim() === "New");
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
});
