// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DriveApiEntry } from "./api";

vi.mock("@/components/apps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/apps")>();
  return {
    ...actual,
    CORE_WORKSPACE_STORAGE_ONLY: true,
  };
});

const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {},
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => routerMocks.navigate,
  useSearch: () => routerMocks.search,
}));

vi.mock("./file-thumbnail", () => ({
  FileThumbnail: () => null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { DriveShell } from "./drive-shell";

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

describe("Drive storage-only MVP actions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    routerMocks.navigate.mockClear();
    routerMocks.search = {};
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
      },
    });
    fetchMock = vi.fn<typeof fetch>((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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
        return Promise.resolve(
          Response.json({
            entries: [
              entry({
                id: "file-report",
                type: "file",
                name: "Report.docx",
                mimeType: "application/msword",
                byteSize: 2048,
              }),
            ],
          }),
        );
      }
      if (url === "/api/tools/drive.search") {
        return Promise.resolve(Response.json({ hits: [] }));
      }
      if (url === "/api/tools/drive.access.list") {
        return Promise.resolve(Response.json({ grants: [] }));
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
    vi.unstubAllGlobals();
  });

  async function settle() {
    for (let i = 0; i < 30; i += 1) {
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    }
  }

  function render() {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <DriveShell />
        </QueryClientProvider>,
      );
    });
  }

  it("selects details without Create copy / Open editor path", async () => {
    render();
    await settle();
    await settle();

    const button = fileButton(container, "Report.docx");
    expect(button).not.toBeNull();
    act(() => {
      button?.click();
    });
    await settle();

    expect(document.body.textContent ?? "").not.toContain("Create editable copy?");
    expect(routerMocks.navigate).not.toHaveBeenCalled();

    const panel = container.querySelector('aside[aria-label="File details"]');
    expect(panel).not.toBeNull();
    const openButton = Array.from(panel?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent?.trim() === "Open",
    );
    expect(openButton).toBeUndefined();
    const download = panel?.querySelector('a[href*="download=1"]');
    expect(download).not.toBeNull();
    expect(download?.textContent ?? "").toMatch(/Download/i);
    expect(download?.className ?? "").toMatch(/primary/);
  });
});
