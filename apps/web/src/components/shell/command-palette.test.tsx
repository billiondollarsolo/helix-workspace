// @vitest-environment jsdom

import { act } from "react";
import { QueryClient } from "@tanstack/react-query";
import { WebPlatformProvider, createWebPlatformHost } from "@helix/sdk-web";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentSearchState } from "@/features/search/use-content-search";
import { CommandPalette } from "./command-palette";

const navigateMock = vi.fn();
const idleContent: ContentSearchState = {
  query: "",
  hitsByType: [],
  people: [],
  loading: false,
  failed: false,
};
const content = vi.hoisted(() => ({ state: undefined as ContentSearchState | undefined }));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("@/features/search/use-content-search", () => ({
  useContentSearch: () => content.state ?? idleContent,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("CommandPalette", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    queryClient = new QueryClient();
    root = createRoot(container);
    navigateMock.mockClear();
    content.state = undefined;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    queryClient.clear();
    vi.clearAllMocks();
  });

  it("renders registered platform commands, filters by keywords, and runs selections", () => {
    const run = vi.fn();
    const close = vi.fn();
    const host = createWebPlatformHost({
      queryClient,
    });
    host.registerCommandPaletteItems([
      {
        id: "drive.inspect-current",
        pluginId: "com.helix.drive",
        label: "Inspect this file",
        group: "Drive",
        keywords: ["question", "current file"],
        shortcut: "Drive",
        run,
      },
    ]);

    render(host, close);

    expect(container.textContent ?? "").toContain("Inspect this file");
    setSearchQuery("question");
    expect(container.textContent ?? "").toContain("Inspect this file");
    expect(container.textContent ?? "").toContain("Drive");

    act(() => {
      buttonWithText("Inspect this file").click();
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("renders disabled registered commands with reasons and does not run them", () => {
    const run = vi.fn();
    const close = vi.fn();
    const host = createWebPlatformHost({
      queryClient,
    });
    host.registerCommandPaletteItems([
      {
        id: "drive.download",
        pluginId: "com.helix.drive",
        label: "Download file",
        group: "Drive",
        keywords: ["download"],
        disabledReason: "Wait for the file scan to finish before downloading.",
        run,
      },
    ]);

    render(host, close);

    const button = buttonWithText("Download file");
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Wait for the file scan to finish before downloading.");
    expect(container.textContent ?? "").toContain(
      "Wait for the file scan to finish before downloading.",
    );

    act(() => {
      button.click();
    });

    expect(run).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("uses combobox/listbox semantics, skips disabled options, and restores focus", async () => {
    const disabledRun = vi.fn();
    const enabledRun = vi.fn();
    const close = vi.fn();
    const host = createWebPlatformHost({
      queryClient,
    });
    host.registerCommandPaletteItems([
      {
        id: "test.disabled",
        pluginId: "test",
        label: "Unavailable paired command",
        keywords: ["paired-command"],
        disabledReason: "Unavailable for this file.",
        run: disabledRun,
      },
      {
        id: "test.enabled",
        pluginId: "test",
        label: "Available paired command",
        keywords: ["paired-command"],
        run: enabledRun,
      },
    ]);
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    render(host, close);
    await act(async () => Promise.resolve());

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    const combobox = container.querySelector<HTMLInputElement>('[role="combobox"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(combobox?.getAttribute("aria-controls")).toBe("command-palette-results");
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    expect(document.activeElement).toBe(combobox);
    expect(document.body.style.overflow).toBe("hidden");

    const tabEvent = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      combobox?.dispatchEvent(tabEvent);
    });
    expect(tabEvent.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(combobox);

    setSearchQuery("paired-command");
    await act(async () => Promise.resolve());
    const enabledOption = buttonWithText("Available paired command");
    expect(combobox?.getAttribute("aria-activedescendant")).toBe(enabledOption.id);
    act(() => {
      combobox?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(disabledRun).not.toHaveBeenCalled();
    expect(enabledRun).toHaveBeenCalledTimes(1);

    render(host, close, false);
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe("");
    opener.remove();
  });

  it("opens compose and the event editor through router params", () => {
    const close = vi.fn();
    render(createWebPlatformHost({ queryClient }), close);

    setSearchQuery("new email");
    act(() => buttonWithText("New email").click());
    expect(navigateMock).toHaveBeenLastCalledWith({ to: "/mail", search: { compose: "new" } });

    setSearchQuery("schedule");
    act(() => buttonWithText("Schedule meeting").click());
    expect(navigateMock).toHaveBeenLastCalledWith({ to: "/calendar", search: { create: "event" } });
  });

  it("lists content results grouped by app under the command matches", () => {
    content.state = {
      query: "harbor",
      hitsByType: [
        {
          type: "mail",
          hits: [
            {
              id: "mail:1",
              type: "mail",
              title: "Harbor review",
              attributes: { threadId: "11111111-1111-4111-8111-111111111111", fromName: "Nora" },
            },
          ],
        },
        {
          type: "drive",
          hits: [
            {
              id: "drive:1",
              type: "drive",
              title: "Harbor brief.md",
              attributes: { fileId: "f-1", parentFolderId: "folder-1" },
            },
          ],
        },
      ],
      people: [
        {
          id: "p-1",
          email: "luca@helix.test",
          displayName: "Luca Harbor",
          kind: "directory",
          favorite: false,
          avatarDataUrl: null,
          relationship: {},
          actorId: null,
          title: null,
        },
      ],
      loading: false,
      failed: false,
    };
    render(createWebPlatformHost({ queryClient }), vi.fn());
    setSearchQuery("harbor");

    const groups = Array.from(container.querySelectorAll('[role="group"]')).map((group) =>
      group.firstElementChild?.textContent?.trim(),
    );
    expect(groups).toEqual(["Search", "Mail", "Files", "People"]);
    expect(buttonWithText("Harbor review").textContent).toContain("Nora");

    act(() => buttonWithText("Harbor review").click());
    expect(navigateMock).toHaveBeenLastCalledWith({
      to: "/mail",
      search: { thread: "11111111-1111-4111-8111-111111111111" },
    });
    act(() => buttonWithText("Harbor brief.md").click());
    expect(navigateMock).toHaveBeenLastCalledWith({
      to: "/drive",
      search: { file: "f-1", folder: "folder-1" },
    });
    act(() => buttonWithText("Luca Harbor").click());
    expect(navigateMock).toHaveBeenLastCalledWith({
      to: "/mail",
      search: { compose: "new", to: "luca@helix.test" },
    });
    act(() => buttonWithText("Search Helix for").click());
    expect(navigateMock).toHaveBeenLastCalledWith({ to: "/search", search: { q: "harbor" } });
  });

  it("announces content search progress and failures", () => {
    content.state = { ...idleContent, query: "har", loading: true };
    render(createWebPlatformHost({ queryClient }), vi.fn());
    setSearchQuery("har");
    expect(container.querySelector(".palette-status")?.textContent).toContain("Searching");

    content.state = { ...idleContent, query: "har", failed: true };
    setSearchQuery("harb");
    expect(container.querySelector(".palette-status")?.textContent).toContain("unavailable");
  });

  function render(
    host: ReturnType<typeof createWebPlatformHost>,
    onClose: () => void,
    open = true,
  ): void {
    act(() => {
      root.render(
        <WebPlatformProvider
          host={host}
          useColorMode={() => ({
            mode: "system",
            resolvedMode: "light",
            setMode: () => undefined,
          })}
        >
          <CommandPalette open={open} onClose={onClose} openSettings={() => undefined} />
        </WebPlatformProvider>,
      );
    });
  }

  function setSearchQuery(value: string): void {
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search apps, files, people, actions"]',
    );
    if (input === null) {
      throw new Error("Missing command palette search input.");
    }
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter === undefined) {
        throw new Error("Missing input value setter.");
      }
      Reflect.apply(setter, input, [value]);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function buttonWithText(text: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes(text),
    );
    if (button === undefined) {
      throw new Error(`Missing button: ${text}`);
    }
    return button;
  }
});
