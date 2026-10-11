// @vitest-environment jsdom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriveShell } from "./drive-shell";
import { FOLDER_CHILDREN, ROOT_ENTRIES, fileButton } from "./drive-shell.fixtures";

const routerMocks = vi.hoisted(() => ({ navigate: vi.fn(), search: {} }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => routerMocks.navigate,
  useSearch: () => routerMocks.search,
}));
vi.mock("./file-thumbnail", () => ({ FileThumbnail: () => null }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** Details panels: rename, version restore, folder details, and Home. */
describe("DriveShell details panels", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let toolCalls: Array<{ url: string; body: unknown }>;
  let mockVersions: ReadonlyArray<{ versionNumber: number; createdAt: string }>;
  let renameFailure: string | null;

  beforeEach(() => {
    document.cookie = "helix_csrf=test-csrf; path=/";
    routerMocks.search = {};
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    toolCalls = [];
    mockVersions = [];
    renameFailure = null;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() },
    });
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (url === "/v1/api/auth/get-session") {
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
      toolCalls.push({ url, body });
      switch (url) {
        case "/v1/api/tools/drive.list": {
          const folderId = (body as { folderId?: string | null }).folderId ?? null;
          return Promise.resolve(
            Response.json({ entries: folderId === "folder-eng" ? FOLDER_CHILDREN : ROOT_ENTRIES }),
          );
        }
        case "/v1/api/tools/drive.view.get":
          return Promise.resolve(Response.json({ view: "grid" }));
        case "/v1/api/tools/drive.access.list":
          return Promise.resolve(Response.json({ grants: [] }));
        case "/v1/api/tools/drive.versions.list":
          return Promise.resolve(Response.json({ versions: mockVersions }));
        case "/v1/api/tools/drive.rename":
          return Promise.resolve(
            renameFailure === null
              ? Response.json({ ...(body as object), type: "file" })
              : Response.json({ error: renameFailure }, { status: 403 }),
          );
        default:
          return Promise.resolve(Response.json({}));
      }
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
    const target = [...container.querySelectorAll<HTMLElement>("button")].find(
      (control) =>
        control.textContent?.includes(label) === true ||
        control.getAttribute("aria-label")?.includes(label) === true,
    );
    if (target === undefined) throw new Error(`Missing control: ${label}`);
    act(() => {
      target.click();
    });
  }
  function setInputValue(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (setter === undefined) throw new Error("native input value setter unavailable");
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("resets the rename field when a different file is selected", async () => {
    render();
    await settle();
    act(() => {
      fileButton(container, "Specs.pdf")?.click();
    });
    await settle();
    const nameInput = () =>
      container.querySelector<HTMLInputElement>(
        'aside[aria-label="File details"] input[aria-label="File name"]',
      );
    expect(nameInput()?.value).toBe("Specs.pdf");
    setInputValue(nameInput()!, "Draft name");
    act(() => {
      fileButton(container, "Roadmap.docx")?.click();
    });
    await settle();
    expect(nameInput()?.value).toBe("Roadmap.docx");
  });
  it("shows the server error when a rename is refused", async () => {
    renameFailure = "Requires 'editor' access on Drive object file-specs; actor has 'reader'.";
    render();
    await settle();
    act(() => {
      fileButton(container, "Specs.pdf")?.click();
    });
    await settle();
    const nameInput = container.querySelector<HTMLInputElement>(
      'aside[aria-label="File details"] input[aria-label="File name"]',
    );
    setInputValue(nameInput!, "Specs v2.pdf");
    clickControl("Rename");
    await settle();
    expect(toolCalls.find((call) => call.url === "/v1/api/tools/drive.rename")?.body).toEqual({
      objectId: "file-specs",
      name: "Specs v2.pdf",
    });
    const alert = container.querySelector('aside[aria-label="File details"] [role="alert"]');
    expect(alert?.textContent).toContain("Requires 'editor' access");
  });
  it("confirms before restoring an older version and never offers the current one", async () => {
    mockVersions = [
      { versionNumber: 3, createdAt: "2026-05-22T12:00:00.000Z" },
      { versionNumber: 2, createdAt: "2026-05-21T12:00:00.000Z" },
    ];
    render();
    await settle();
    act(() => {
      fileButton(container, "Specs.pdf")?.click();
    });
    await settle();
    const history = container.querySelector('section[aria-label="Version history"]');
    expect(history?.textContent).toContain("Current");
    expect(history?.querySelector('[aria-label="Restore version 3"]')).toBeNull();
    clickControl("Restore version 2");
    await settle();
    expect(toolCalls.some((call) => call.url === "/v1/api/tools/drive.versions.revert")).toBe(
      false,
    );
    clickControl("Confirm restore of version 2");
    await settle();
    expect(
      toolCalls.find((call) => call.url === "/v1/api/tools/drive.versions.revert")?.body,
    ).toEqual({ objectId: "file-specs", versionNumber: 2 });
    expect(container.textContent ?? "").toContain("Version restored.");
  });
  it("opens folder details to rename and share a folder without public links", async () => {
    render();
    await settle();
    clickControl("Details for Engineering");
    await settle();
    const panel = container.querySelector('aside[aria-label="Folder details"]');
    expect(panel).not.toBeNull();
    expect(container.querySelector('aside[aria-label="File details"]')).toBeNull();
    const nameInput = panel!.querySelector<HTMLInputElement>('input[aria-label="Folder name"]');
    expect(nameInput?.value).toBe("Engineering");
    setInputValue(nameInput!, "Platform");
    const renameButton = Array.from(panel!.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Rename",
    );
    act(() => {
      renameButton?.click();
    });
    await settle();
    expect(toolCalls.find((call) => call.url === "/v1/api/tools/drive.rename")?.body).toEqual({
      objectId: "folder-eng",
      name: "Platform",
    });
    expect(panel?.textContent).toContain("Renamed.");

    const shareButton = Array.from(panel!.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Share",
    );
    act(() => {
      shareButton?.click();
    });
    await settle();
    const dialog = container.querySelector('[role="dialog"][aria-label="Share Engineering"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).not.toContain("Create public link");
    expect(document.activeElement?.id).toBe("share-targets-folder-eng");
    expect(toolCalls.find((call) => call.url === "/v1/api/tools/drive.access.list")?.body).toEqual({
      objectId: "folder-eng",
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
  it("opens a folder from its details panel", async () => {
    render();
    await settle();
    clickControl("Details for Engineering");
    await settle();
    const openButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('aside[aria-label="Folder details"] button'),
    ).find((button) => button.textContent?.trim() === "Open");
    expect(openButton).toBeDefined();
    act(() => {
      openButton?.click();
    });
    await settle();
    expect(container.querySelector('aside[aria-label="Folder details"]')).toBeNull();
    expect(container.textContent ?? "").toContain("Nested-spec.pdf");
  });
  it("builds Home from root folders and recently updated files across folders", async () => {
    render();
    await settle();
    clickControl("Home");
    await settle();
    const listBodies = toolCalls
      .filter((call) => call.url === "/v1/api/tools/drive.list")
      .map((call) => call.body as { acrossFolders?: boolean; folderId?: string | null });
    expect(listBodies.some((body) => body.acrossFolders === true)).toBe(true);
    expect(container.textContent ?? "").toContain("Engineering");
    expect(container.textContent ?? "").toContain("Specs.pdf");
    expect(container.querySelectorAll('[aria-label="Details for Engineering"]')).toHaveLength(1);
  });
});
