// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette, navigationTargetForSearchHit } from "./command-palette";
import type { GlobalSearchHit } from "@/features/search/api";

const mocks = vi.hoisted(() => ({
  commandRun: vi.fn(),
  navigate: vi.fn(),
  useQuery: vi.fn(),
}));

const platformHost = {
  getCommandPaletteItems: () => [
    {
      group: "Navigation",
      id: "open-mail",
      keywords: ["inbox"],
      label: "Open Mail",
      pluginId: "mail",
      run: mocks.commandRun,
      shortcut: "G M",
    },
  ],
  trpc: {
    endpoint: "http://localhost/api/trpc",
  },
};

vi.mock("@helix/sdk-web", () => ({
  usePlatformSnapshot: (selector: (host: typeof platformHost) => unknown) => selector(platformHost),
  useWebPlatformHost: () => platformHost,
}));

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: mocks.useQuery,
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const backendHits = [
  {
    body: "Backend result body",
    id: "docs:launch-plan",
    title: "Launch plan",
    type: "docs",
    url: "/docs/launch-plan",
  },
  {
    body: "Drive result body",
    id: "drive:launch-deck",
    title: "Launch deck",
    type: "drive",
    url: "/drive/launch-deck",
  },
] satisfies readonly GlobalSearchHit[];

describe("CommandPalette", () => {
  let container: HTMLDivElement;
  let root: Root;
  let open: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.commandRun.mockReset();
    mocks.navigate.mockReset();
    mocks.useQuery.mockReset();
    mocks.useQuery.mockReturnValue({
      data: { hits: backendHits, query: "launch" },
      isError: false,
      isLoading: false,
    });
    globalThis.ResizeObserver = class ResizeObserver {
      disconnect() {
        return undefined;
      }

      observe() {
        return undefined;
      }

      unobserve() {
        return undefined;
      }
    };
    Element.prototype.scrollIntoView = () => undefined;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    open = true;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    vi.useRealTimers();
    container.remove();
    document.body.replaceChildren();
  });

  it("renders backend search results inside the virtualized result container", async () => {
    await renderPalette();
    await typeSearch("launch");
    await advanceSearchDebounce();

    const virtualizer = document.body.querySelector(
      '[data-testid="command-palette-search-virtualizer"]',
    );
    expect(virtualizer).toBeInstanceOf(HTMLElement);
    expect(virtualizer?.textContent).toContain("Launch plan");
    expect(virtualizer?.textContent).toContain("Backend result body");
    expect(virtualizer?.querySelectorAll("[cmdk-item]").length).toBeGreaterThan(0);
  });

  it("filters local commands immediately while backend search waits for the debounced value", async () => {
    await renderPalette();
    await typeSearch("inbox");

    expect(commandItem("Open Mail")).toBeInstanceOf(HTMLElement);
    expect(
      document.body.querySelector('[data-testid="command-palette-search-virtualizer"]'),
    ).toBeNull();
    expect(backendSearchQueries()).not.toContain("inbox");

    await advanceSearchDebounce();

    expect(backendSearchQueries()).toContain("inbox");
  });

  it("keeps local command selection behavior intact", async () => {
    await renderPalette();

    const command = commandItem("Open Mail");
    await act(async () => {
      command.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      command.click();
      await Promise.resolve();
    });

    expect(mocks.commandRun).toHaveBeenCalledTimes(1);
    expect(open).toBe(false);
  });

  it("keeps backend search result click navigation intact", async () => {
    await renderPalette();
    await typeSearch("launch");
    await advanceSearchDebounce();

    const result = commandItem("Launch plan");
    await act(async () => {
      result.click();
      await Promise.resolve();
    });

    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/drive",
      search: { file: "launch-plan" },
    });
    expect(open).toBe(false);
  });

  it("keeps keyboard shortcut toggling intact", async () => {
    await renderPalette();

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "k", metaKey: true }),
      );
      await Promise.resolve();
    });

    expect(open).toBe(false);
  });

  async function renderPalette() {
    await act(async () => {
      root.render(<CommandPalette open={open} setOpen={setOpen} />);
      await Promise.resolve();
    });
  }

  function setOpen(nextOpen: boolean) {
    open = nextOpen;
    root.render(<CommandPalette open={open} setOpen={setOpen} />);
  }

  async function typeSearch(value: string) {
    const input = document.body.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Missing command palette input");
    }

    await act(async () => {
      const setInputValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.bind(input);
      setInputValue?.(value);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
  }

  async function advanceSearchDebounce() {
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
  }

  function backendSearchQueries() {
    const calls = mocks.useQuery.mock.calls as unknown as ReadonlyArray<readonly [unknown]>;
    return calls.flatMap(([options]) => (hasQueryKey(options) ? [options.queryKey[1]] : []));
  }

  function hasQueryKey(value: unknown): value is { queryKey: readonly unknown[] } {
    if (typeof value !== "object" || value === null || !("queryKey" in value)) {
      return false;
    }

    return Array.isArray((value as { queryKey?: unknown }).queryKey);
  }

  function commandItem(text: string) {
    const item = [...document.body.querySelectorAll("[cmdk-item]")].find((element) =>
      element.textContent?.includes(text),
    );
    if (!(item instanceof HTMLElement)) {
      throw new Error(`Missing command item: ${text}`);
    }
    return item;
  }
});

describe("navigationTargetForSearchHit", () => {
  it("maps backend mail search hits to thread URL state", () => {
    expect(
      navigationTargetForSearchHit({
        id: "mail:message-1",
        type: "mail",
        title: "Launch plan",
        url: "/mail/thread-1?message=message-1",
        attributes: {
          threadId: "thread-from-attributes",
          messageId: "message-from-attributes",
        },
      } satisfies GlobalSearchHit),
    ).toEqual({
      route: "/mail",
      thread: "thread-from-attributes",
      message: "message-from-attributes",
    });
  });

  it("maps backend chat and calendar search URLs to supported shell params", () => {
    expect(
      navigationTargetForSearchHit({
        id: "chat:message-1",
        type: "chat",
        url: "/chat/room-1?message=message-1",
      } satisfies GlobalSearchHit),
    ).toEqual({
      route: "/chat",
      room: "room-1",
      message: "message-1",
    });

    expect(
      navigationTargetForSearchHit({
        id: "calendar:event-1",
        type: "calendar",
        url: "/calendar/events/event-1",
      } satisfies GlobalSearchHit),
    ).toEqual({
      route: "/calendar",
      event: "event-1",
    });
  });

  it("maps backend Drive search hits to file URL state", () => {
    expect(
      navigationTargetForSearchHit({
        id: "drive:object-1",
        type: "drive",
        title: "Launch deck",
        url: "/drive/object-from-url",
        attributes: {
          objectId: "object-from-attributes",
        },
      } satisfies GlobalSearchHit),
    ).toEqual({
      route: "/drive",
      file: "object-from-attributes",
    });

    expect(
      navigationTargetForSearchHit({
        id: "drive:object-2",
        type: "drive",
        title: "Launch deck",
        url: "/drive?id=object-from-id-param",
      } satisfies GlobalSearchHit),
    ).toEqual({
      route: "/drive",
      file: "object-from-id-param",
    });
  });
});
