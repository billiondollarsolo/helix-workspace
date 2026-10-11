// @vitest-environment jsdom

import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalSearchHit } from "./api";
import type { SearchFilter } from "./route-search";
import { SearchResultsShell } from "./search-results-shell";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search,
    children,
    ...props
  }: {
    readonly to: string;
    readonly search?: Record<string, string | boolean>;
    readonly children: ReactNode;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href={`${to}?${new URLSearchParams(search as Record<string, string>).toString()}`}
      {...props}
    >
      {children}
    </a>
  ),
}));

const hits = [
  {
    id: "mail:1",
    type: "mail",
    title: "Launch plan",
    body: "Launch plan\nNora Patel <nora@helix.test>\nmira@helix.test\nPlanning notes for the launch next week.",
    attributes: {
      threadId: "11111111-1111-4111-8111-111111111111",
      fromName: "Nora Patel",
      sentAt: "2026-05-20T12:00:00.000Z",
    },
  },
  {
    id: "drive:1",
    type: "drive",
    title: "Launch deck.pdf",
    body: "Launch deck.pdf application/pdf",
    attributes: { fileId: "f-1", parentFolderId: "folder-1", path: ["Launch", "Launch deck.pdf"] },
  },
] satisfies readonly GlobalSearchHit[];

const people = [
  {
    id: "p-1",
    email: "luca@helix.test",
    displayName: "Luca Launch",
    kind: "directory",
    favorite: false,
    avatarDataUrl: null,
    relationship: {},
    actorId: null,
    title: null,
  },
];

describe("SearchResultsShell", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let searchFails = false;

  beforeEach(() => {
    searchFails = false;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchMock = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.includes("search.query")) {
        return Promise.resolve(
          searchFails
            ? Response.json({ error: "down" }, { status: 503 })
            : Response.json({ hits, query: "launch", estimatedTotalHits: hits.length }),
        );
      }
      if (url.includes("/api/people")) {
        return Promise.resolve(Response.json({ people }));
      }
      return Promise.resolve(Response.json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    client.clear();
    vi.unstubAllGlobals();
  });

  function render(query: string, filter?: SearchFilter, onFilterChange = vi.fn()) {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <SearchResultsShell query={query} filter={filter} onFilterChange={onFilterChange} />
        </QueryClientProvider>,
      );
    });
    return onFilterChange;
  }

  async function settle() {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  function searchBodies(): unknown[] {
    return fetchMock.mock.calls
      .filter(([input]) => requestUrl(input).includes("search.query"))
      .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
  }

  it("prompts for a query before searching", () => {
    render("");
    expect(container.textContent).toContain("Search mail, files, chat messages, events and people");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists people and ranked content with links into each app", async () => {
    render("launch");
    await settle();

    expect(container.textContent).toContain("3 results for “launch”");
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>("a.search-result"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/mail?compose=new&to=luca%40helix.test",
      "/mail?thread=11111111-1111-4111-8111-111111111111",
      "/drive?file=f-1&folder=folder-1",
    ]);
    expect(links[1]?.textContent).toContain("Mail · Nora Patel");
    expect(links[1]?.textContent).toContain("Planning notes for the launch");
    expect(links[1]?.textContent).not.toContain("nora@helix.test");
    expect(links[2]?.textContent).toContain("in Launch");
    expect(searchBodies()).toEqual([{ query: "launch", limit: 20, offset: 0 }]);
  });

  it("filters by app with pressed chips", async () => {
    const onFilterChange = render("launch", "drive");
    await settle();
    const chips = Array.from(container.querySelectorAll<HTMLButtonElement>(".search-chip"));
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "All",
      "Mail",
      "Files",
      "Chat messages",
      "Events",
      "People",
    ]);
    expect(chips.find((chip) => chip.getAttribute("aria-pressed") === "true")?.textContent).toBe(
      "Files",
    );
    expect(searchBodies()).toEqual([{ query: "launch", types: ["drive"], limit: 20, offset: 0 }]);
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).includes("/api/people"))).toBe(
      false,
    );

    act(() => chips[5]?.click());
    expect(onFilterChange).toHaveBeenCalledWith("people");
  });

  it("explains a failed search and retries it", async () => {
    searchFails = true;
    render("launch", "mail");
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Search is unavailable",
    );
    searchFails = false;
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry search",
    );
    act(() => retry?.click());
    await settle();
    expect(container.textContent).toContain("Launch plan");
  });
});

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}
