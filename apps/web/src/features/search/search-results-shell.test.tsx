// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchResultsShell } from "./search-results-shell";
import type { GlobalSearchHit } from "./api";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const backendHits = [
  {
    body: "Planning notes for the launch",
    id: "docs:launch-plan",
    score: 0.91,
    title: "Launch plan",
    type: "docs",
    updatedAt: "2026-05-20T12:00:00.000Z",
    url: "/docs/launch-plan",
  },
  {
    body: "Drive result body",
    id: "drive:launch-deck",
    score: 0.72,
    title: "Launch deck",
    type: "drive",
    updatedAt: "2026-05-20T12:05:00.000Z",
    url: "/drive/launch-deck",
  },
] satisfies readonly GlobalSearchHit[];

describe("SearchResultsShell", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: 0,
        },
      },
    });
    fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          estimatedTotalHits: backendHits.length,
          hits: backendHits,
          query: "launch",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
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
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    vi.useRealTimers();
    container.remove();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("renders backend search hits in a virtualized shadcn table", async () => {
    renderSearch();
    await waitForText("Launch plan");

    const virtualizer = container.querySelector('[data-testid="search-results-virtualizer"]');
    expect(virtualizer).toBeInstanceOf(HTMLDivElement);
    const table = container.querySelector("table");
    expect(table).toBeInstanceOf(HTMLTableElement);
    expect(table?.textContent).toContain("Planning notes for the launch");
    expect(table?.querySelector("[data-index='0']")).toBeInstanceOf(HTMLTableRowElement);

    expect(JSON.parse(requestBodyAt(0))).toEqual({
      limit: 100,
      offset: 0,
      query: "launch",
    });
  });

  it("opens a selected search hit", async () => {
    const onOpenSearchHit = vi.fn();
    renderSearch({ onOpenSearchHit });
    await waitForText("Launch plan");

    await act(async () => {
      button("Open Launch plan").click();
      await Promise.resolve();
    });

    expect(onOpenSearchHit).toHaveBeenCalledWith(backendHits[0]);
  });

  it("projects result type filters into route state and backend query input", async () => {
    const onSearchStateChange = vi.fn();
    renderSearch({ onSearchStateChange });
    await waitForText("Launch plan");

    await act(async () => {
      button("Drive").click();
      await Promise.resolve();
    });
    await waitForFetchCallCount(2);

    expect(onSearchStateChange).toHaveBeenLastCalledWith({ q: "launch", types: ["drive"] });
    expect(JSON.parse(requestBodyAt(1))).toEqual({
      limit: 100,
      offset: 0,
      query: "launch",
      types: ["drive"],
    });
  });

  function renderSearch(
    props: Partial<Parameters<typeof SearchResultsShell>[0]> = {},
  ) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SearchResultsShell initialQuery="launch" {...props} />
        </QueryClientProvider>,
      );
    });
  }

  async function waitForText(text: string) {
    for (let index = 0; index < 20; index += 1) {
      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });
      if (container.textContent?.includes(text)) {
        return;
      }
    }
    throw new Error(`Missing text: ${text}`);
  }

  async function waitForFetchCallCount(count: number) {
    for (let index = 0; index < 20; index += 1) {
      await act(async () => {
        await Promise.resolve();
      });
      if (fetchMock.mock.calls.length >= count) {
        return;
      }
    }
    throw new Error(`Expected ${String(count)} fetch calls.`);
  }

  function button(name: string) {
    const candidate = [...container.querySelectorAll("button")].find(
      (element) => element.textContent === name || element.getAttribute("aria-label") === name,
    );
    if (!(candidate instanceof HTMLButtonElement)) {
      throw new Error(`Missing button: ${name}`);
    }
    return candidate;
  }

  function requestBodyAt(index: number): string {
    const body = fetchMock.mock.calls[index]?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error(`Missing string request body at index ${String(index)}`);
    }
    return body;
  }
});
