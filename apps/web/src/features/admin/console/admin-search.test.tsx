// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axeViolations, byRole, mount, press, unmountAll } from "@/test/ui";
import { AdminSearch } from "./admin-search";

const navigateMock = vi.fn();

vi.mock("@tanstack/react-router", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return { ...actual, useNavigate: () => navigateMock };
});

const USERS = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    orgId: "org-1",
    type: "user",
    email: "riley@helix.local",
    displayName: "Riley Chen",
    scopes: [],
    disabledAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

const GROUPS = [
  {
    id: "22222222-2222-4222-8222-222222222222",
    orgId: "org-1",
    name: "Riley's reading club",
    email: "reading@helix.local",
    kind: "mailing_list",
    postingPolicy: "organization",
    description: "",
    orgUnitId: null,
    memberCount: 3,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    orgId: "org-1",
    name: "Finance",
    email: null,
    kind: "group",
    postingPolicy: "organization",
    description: "",
    orgUnitId: null,
    memberCount: 2,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

const requests: string[] = [];

beforeEach(() => {
  navigateMock.mockReset();
  requests.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://test");
      requests.push(`${url.pathname}${url.search}`);
      const body = url.pathname.endsWith("/admin/users")
        ? {
            users: USERS.filter((user) =>
              user.displayName.toLowerCase().includes(url.searchParams.get("query") ?? ""),
            ),
            nextCursor: null,
          }
        : url.pathname.endsWith("/admin/groups")
          ? { groups: GROUPS }
          : {};
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

function renderSearch() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return mount(
    <QueryClientProvider client={client}>
      <AdminSearch />
    </QueryClientProvider>,
  );
}

function input(): HTMLInputElement {
  const node = document.querySelector<HTMLInputElement>('[role="combobox"]');
  if (node === null) throw new Error("no combobox");
  return node;
}

async function type(value: string) {
  const node = input();
  act(() => node.focus());
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
  /* Past the 200 ms debounce, then let the queries resolve. */
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function optionTitles(): string[] {
  return byRole("option").map(
    (option) => option.querySelector(".admin-search-option-title")?.textContent ?? "",
  );
}

describe("AdminSearch", () => {
  it("is a labelled combobox that starts collapsed", async () => {
    renderSearch();
    expect(input().getAttribute("aria-label")).toBe("Search admin settings, users, and groups");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(await axeViolations()).toEqual([]);
  });

  it("finds settings, users, and groups for one query", async () => {
    renderSearch();
    await type("riley");
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(optionTitles()).toEqual(["Riley Chen", "Riley's reading club"]);
    expect(byRole("group").map((group) => group.getAttribute("aria-label"))).toEqual([
      "Users",
      "Groups",
    ]);
    expect(requests.some((request) => request.includes("query=riley"))).toBe(true);
    expect(await axeViolations()).toEqual([]);
  });

  it("lists settings from the static index first", async () => {
    renderSearch();
    await type("dkim");
    expect(optionTitles()[0]).toBe("Mail domains");
    expect(byRole("group")[0]?.getAttribute("aria-label")).toBe("Settings");
  });

  it("moves through results with the arrow keys and opens one with Enter", async () => {
    renderSearch();
    await type("riley");
    press("ArrowDown", {}, input());
    const active = input().getAttribute("aria-activedescendant");
    expect(document.getElementById(active ?? "")?.textContent).toContain("Riley's reading club");
    press("Enter", {}, input());
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/admin/$section",
      params: { section: "groups" },
      search: { group: "22222222-2222-4222-8222-222222222222" },
    });
  });

  it("opens a user's details from a user result", async () => {
    renderSearch();
    await type("riley");
    press("Enter", {}, input());
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/admin/$section",
      params: { section: "users" },
      search: { user: "11111111-1111-4111-8111-111111111111" },
    });
  });

  it("opens a setting on its page and tab", async () => {
    renderSearch();
    await type("spam filtering");
    press("Enter", {}, input());
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/admin/$section",
      params: { section: "mail" },
      search: { tab: "spam" },
    });
  });

  it("says so when nothing matches, and Escape closes the list", async () => {
    renderSearch();
    await type("zzzz-nothing");
    expect(document.querySelector(".admin-search-empty")?.textContent).toBe(
      "No results for “zzzz-nothing”",
    );
    press("Escape", {}, input());
    expect(document.querySelector(".admin-search-empty")).toBeNull();
  });
});
