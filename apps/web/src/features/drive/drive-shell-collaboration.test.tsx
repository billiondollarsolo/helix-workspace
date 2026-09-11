// @vitest-environment jsdom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DriveApiEntry } from "./api";
import { DriveShell } from "./drive-shell";

const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {},
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => routerMocks.navigate,
  useSearch: () => routerMocks.search,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function entry(
  overrides: Partial<DriveApiEntry> & Pick<DriveApiEntry, "id" | "type" | "name">,
): DriveApiEntry {
  return {
    folderId: null,
    ownerActorId: "owner-1",
    uploadState: "active",
    available: true,
    metadata: {},
    deletedAt: null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
    ...overrides,
  };
}

const ENTRIES: readonly DriveApiEntry[] = [
  entry({
    id: "file-specs",
    type: "file",
    name: "Specs.pdf",
    mimeType: "application/pdf",
    byteSize: 1024,
  }),
  entry({
    id: "file-shared",
    type: "file",
    name: "Shared-brief.pdf",
    ownerActorId: "other-1",
    mimeType: "application/pdf",
    byteSize: 512,
  }),
];

describe("DriveShell collaboration actions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let toolCalls: Array<{ url: string; body: unknown }>;

  beforeEach(() => {
    document.cookie = "helix_csrf=test-csrf; path=/";
    routerMocks.search = {};
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    toolCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        if (url !== "/v1/api/auth/get-session") toolCalls.push({ url, body });
        if (url === "/v1/api/auth/get-session") {
          return Promise.resolve(
            Response.json({
              user: {
                id: "session-user",
                email: "owner@helix.local",
                name: "Owner",
                actorId: "owner-1",
              },
            }),
          );
        }
        if (url === "/v1/api/tools/drive.list") {
          return Promise.resolve(Response.json({ entries: ENTRIES }));
        }
        if (url === "/v1/api/tools/drive.view.get")
          return Promise.resolve(Response.json({ view: "grid" }));
        if (url === "/v1/api/tools/drive.access.list")
          return Promise.resolve(Response.json({ grants: [] }));
        if (url === "/v1/api/tools/drive.access.requests") {
          return Promise.resolve(Response.json({ requests: [] }));
        }
        if (url === "/v1/api/tools/drive.quota.usage") {
          return Promise.resolve(
            Response.json({ usedBytes: 1, limitBytes: 10, unlimited: false, percentUsed: 10 }),
          );
        }
        if (url === "/v1/api/tools/drive.versions.list")
          return Promise.resolve(Response.json({ versions: [] }));
        if (url === "/v1/api/tools/drive.copy") {
          return Promise.resolve(
            Response.json({ ...ENTRIES[0], id: "file-copy", name: "Copy of Specs.pdf" }),
          );
        }
        if (url === "/v1/api/tools/drive.hide.set") {
          return Promise.resolve(
            Response.json({ objectId: (body as { objectId?: string }).objectId, hidden: true }),
          );
        }
        if (url === "/v1/api/tools/drive.search")
          return Promise.resolve(Response.json({ hits: [] }));
        return Promise.resolve(Response.json({}));
      }),
    );
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  async function settle() {
    for (let i = 0; i < 20; i += 1) {
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

  function click(label: string) {
    const target = Array.from(
      container.querySelectorAll<HTMLElement>("button,[role='button']"),
    ).find(
      (node) =>
        node.textContent?.includes(label) === true || node.getAttribute("aria-label") === label,
    );
    act(() => {
      target?.click();
    });
  }

  it("copies from details and the overflow menu", async () => {
    render();
    await settle();
    click("Specs.pdf");
    click("Make a copy");
    await settle();
    expect(toolCalls.find((call) => call.url === "/v1/api/tools/drive.copy")?.body).toEqual({
      objectId: "file-specs",
      folderId: null,
    });
    click("Actions for Specs.pdf");
    const menuCopy = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[role='menuitem']"),
    ).find((button) => button.textContent === "Make a copy");
    act(() => {
      menuCopy?.click();
    });
    await settle();
    expect(toolCalls.filter((call) => call.url === "/v1/api/tools/drive.copy")).toHaveLength(2);
  });

  it("hides a shared file without trashing it", async () => {
    render();
    await settle();
    click("Shared with me");
    await settle();
    click("Shared-brief.pdf");
    click("Remove from Shared with me");
    await settle();
    expect(toolCalls.find((call) => call.url === "/v1/api/tools/drive.hide.set")?.body).toEqual({
      objectId: "file-shared",
      hidden: true,
    });
    expect(toolCalls.some((call) => call.url === "/v1/api/tools/drive.trash")).toBe(false);
  });
});
