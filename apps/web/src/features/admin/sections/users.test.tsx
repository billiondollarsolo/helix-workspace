// @vitest-environment jsdom

/* Users directory contracts: dotted-scope roles, selection, and controls.
 * The fetch double honors query, type, includeDisabled, and cursor so server
 * search is exercised across the full directory, not just the loaded page. */

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminUsers, prefetchAdminDirectoryQuery } from "@/features/admin/sections/users";
import { adminUsersInfiniteQueryOptions } from "@/features/admin/admin-users";
import { adminScopesOf, roleForActor } from "@/features/admin/admin-console-data";
import { key } from "@/test/ui";

const navigateMock = vi.fn();
const routerSearch = { current: {} as Record<string, unknown> };

vi.mock("@tanstack/react-router", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useSearch: () => routerSearch.current,
  };
});

interface ApiUser {
  readonly id: string;
  readonly orgId: string;
  readonly type: string;
  readonly email: string | null;
  readonly displayName: string;
  readonly scopes: readonly string[];
  readonly status: "active" | "invited" | "suspended" | "removed";
  readonly disabledAt: string | null;
  readonly lastSignInAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function apiUser(overrides: Partial<ApiUser> & Pick<ApiUser, "id">): ApiUser {
  return {
    orgId: "org-1",
    type: "user",
    email: `${overrides.id}@helix.local`,
    displayName: `User ${overrides.id}`,
    scopes: [],
    status: "active",
    disabledAt: null,
    lastSignInAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/* Mirrors the seeded workspace admin: a bare `admin` marker alongside the
   dotted grants, and no `admin.*` wildcard. */
const SEEDED_ADMIN_SCOPES = [
  "admin",
  "admin.users",
  "admin.audit",
  "admin.agents",
  "admin.config.write",
];

describe("roleForActor", () => {
  it("treats only the wildcards and system actors as unrestricted Admin", () => {
    expect(roleForActor({ type: "user", scopes: ["admin.*"] })).toBe("Admin");
    expect(roleForActor({ type: "user", scopes: ["*"] })).toBe("Admin");
    // `actorHasScope` short-circuits every check for a system actor.
    expect(roleForActor({ type: "system", scopes: [] })).toBe("Admin");
  });

  it("calls an actor holding only a dotted admin scope a Scoped admin, not a Member", () => {
    // The regression: `scopes.includes("admin")` rendered this auditor as a
    // Member and hid them from the Admin filter.
    expect(roleForActor({ type: "user", scopes: ["admin.audit"] })).toBe("Scoped admin");
    expect(roleForActor({ type: "user", scopes: SEEDED_ADMIN_SCOPES })).toBe("Scoped admin");
  });

  it("does not mistake a non-admin scope with an admin prefix or suffix", () => {
    expect(roleForActor({ type: "user", scopes: ["mail.admin"] })).toBe("Member");
    expect(roleForActor({ type: "user", scopes: ["administrator"] })).toBe("Member");
    expect(roleForActor({ type: "user", scopes: ["mail.read", "drive.write"] })).toBe("Member");
  });

  it("reports the admin scopes behind the role so an auditor is distinguishable", () => {
    expect(adminScopesOf(["mail.read", "admin.audit"])).toEqual(["admin.audit"]);
    expect(adminScopesOf(SEEDED_ADMIN_SCOPES)).toEqual(SEEDED_ADMIN_SCOPES);
    expect(adminScopesOf(["mail.admin", "drive.read"])).toEqual([]);
  });
});

describe("AdminUsers", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let clipboardWrite: ReturnType<typeof vi.fn>;
  let requests: URL[];

  /** A stand-in for `GET /api/admin/users`: it filters on `query`, `type` and
   *  `includeDisabled` exactly as the SQL does, and pages with an opaque cursor
   *  (here, the offset). `pageSize` defaults to one page holding everything. */
  function mockUsers(users: readonly ApiUser[], pageSize?: number) {
    const size = pageSize ?? Math.max(users.length, 1);
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(href, "http://localhost");
      requests.push(url);
      const needle = (url.searchParams.get("query") ?? "").toLowerCase();
      const type = url.searchParams.get("type") ?? "";
      const includeDisabled = url.searchParams.get("includeDisabled") === "true";
      const matching = users.filter((user) => {
        if (
          needle !== "" &&
          !user.displayName.toLowerCase().includes(needle) &&
          !(user.email ?? "").toLowerCase().includes(needle) &&
          !user.id.toLowerCase().includes(needle)
        ) {
          return false;
        }
        if (type !== "" && user.type !== type) {
          return false;
        }
        if (!includeDisabled && user.disabledAt !== null) {
          return false;
        }
        return true;
      });
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const page = matching.slice(start, start + size);
      const next = start + page.length;
      return Promise.resolve(
        Response.json({ users: page, nextCursor: next < matching.length ? String(next) : null }),
      );
    });
  }

  /** Polls with real timers — react-query settles over several ticks, so a
   *  fixed number of microtask flushes is racy. The search box also debounces
   *  through Pacer, so assertions about a typed query wait here too. */
  async function waitFor(assertion: () => void, timeout = 2000): Promise<void> {
    const start = Date.now();
    let lastError: unknown;
    while (Date.now() - start <= timeout) {
      try {
        assertion();
        return;
      } catch (error) {
        lastError = error;
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  function render(): Promise<void> {
    return act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(AdminUsers) as ReactNode,
        ),
      );
      return Promise.resolve();
    });
  }

  async function renderWith(users: readonly ApiUser[], pageSize?: number) {
    mockUsers(users, pageSize);
    await render();
    const expected = Math.min(pageSize ?? users.length, users.length);
    await waitFor(() => {
      expect(visibleUsers()).toHaveLength(expected);
    });
  }

  function text(): string {
    return container.textContent ?? "";
  }

  /** Display names of the rows currently rendered, read off each row's own
   *  select checkbox so filtering assertions cannot be satisfied by a <option>
   *  or heading that merely repeats the same word. */
  function visibleUsers(): readonly string[] {
    return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .map((input) => input.getAttribute("aria-label") ?? "")
      .filter((label) => label.startsWith("Select ") && label !== "Select all users")
      .map((label) => label.slice("Select ".length));
  }

  /** The role chip text of each rendered row, in row order. */
  function visibleRoles(): readonly string[] {
    return [...container.querySelectorAll('[role="row"] .chip')]
      .map((chip) => chip.textContent?.trim() ?? "")
      .filter((value) => /^(Admin|Scoped admin|Member)$/u.test(value));
  }

  /** Opens a row's ⋮ menu and returns its item labels. */
  async function openRowMenu(name: string): Promise<readonly string[]> {
    const trigger = container.querySelector<HTMLButtonElement>(
      `button[aria-label="Actions for ${name}"]`,
    );
    if (!trigger) {
      throw new Error(`No row menu for ${name}`);
    }
    trigger.focus();
    await key("Enter", {}, trigger);
    return [...document.querySelectorAll('[role="menuitem"]')].map(
      (item) => item.textContent?.trim() ?? "",
    );
  }

  async function selectMenuItem(label: string): Promise<void> {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (element) => element.textContent?.trim() === label,
    );
    if (!item) {
      throw new Error(`No menu item ${label}`);
    }
    item.focus();
    await key("Enter", {}, item);
  }

  function button(label: string): HTMLButtonElement {
    const match = [...container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === label,
    );
    if (!match) {
      throw new Error(`Button "${label}" not found. Buttons: ${buttonLabels().join(" | ")}`);
    }
    return match;
  }

  function buttonLabels(): readonly string[] {
    return [...container.querySelectorAll("button")].map((el) => el.textContent?.trim() ?? "");
  }

  function checkbox(label: string): HTMLInputElement {
    const match = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (!match) {
      throw new Error(`Checkbox "${label}" not found`);
    }
    return match;
  }

  function click(element: HTMLElement): Promise<void> {
    return act(() => {
      element.click();
      return Promise.resolve();
    });
  }

  /* React tracks the last value it wrote to a control, so assigning `.value`
     directly is swallowed as a no-op change. Both setters go through the
     native prototype descriptor to defeat that tracker. */
  function selectValue(ariaLabel: string, value: string): Promise<void> {
    const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${ariaLabel}"]`);
    if (!select) {
      throw new Error(`Select "${ariaLabel}" not found`);
    }
    return act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set?.call(
        select,
        value,
      );
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return Promise.resolve();
    });
  }

  function typeSearch(value: string): Promise<void> {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search users"]');
    if (!input) {
      throw new Error("Search input not found");
    }
    return act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
        input,
        value,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return Promise.resolve();
    });
  }

  /** Every directory request the component made, in order. */
  function requestedQueries(): readonly string[] {
    return requests.map((url) => url.searchParams.get("query") ?? "");
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock = vi.fn<typeof fetch>();
    requests = [];
    vi.stubGlobal("fetch", fetchMock);
    clipboardWrite = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    routerSearch.current = {};
    navigateMock.mockReset();
    navigateMock.mockImplementation(
      async (opts: { search?: (prev: Record<string, unknown>) => Record<string, unknown> }) => {
        if (typeof opts.search === "function") {
          routerSearch.current = opts.search({ ...routerSearch.current });
        }
        await act(() => {
          root.render(
            createElement(QueryClientProvider, { client: queryClient }, createElement(AdminUsers)),
          );
          return Promise.resolve();
        });
      },
    );
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows each person's role and matches the role filter", async () => {
    await renderWith([
      apiUser({ id: "u-auditor", displayName: "Ada Auditor", scopes: ["admin.audit"] }),
      apiUser({ id: "u-owner", displayName: "Olu Owner", scopes: ["admin.*"] }),
      apiUser({ id: "u-plain", displayName: "Pat Plain", scopes: ["mail.read"] }),
    ]);

    expect(visibleRoles()).toEqual(["Scoped admin", "Admin", "Member"]);

    await selectValue("Role", "Scoped admin");
    expect(visibleUsers()).toEqual(["Ada Auditor"]);
    await selectValue("Role", "Admin");
    expect(visibleUsers()).toEqual(["Olu Owner"]);
    await selectValue("Role", "Member");
    expect(visibleUsers()).toEqual(["Pat Plain"]);
  });

  it("renders the directory as a named, selectable list with column captions", async () => {
    await renderWith([
      apiUser({ id: "u-1", displayName: "One" }),
      apiUser({ id: "u-2", displayName: "Two" }),
    ]);

    const grid = container.querySelector('[role="grid"][aria-label="Users"]');
    expect(grid).not.toBeNull();
    expect(grid?.querySelectorAll('[role="row"]')).toHaveLength(2);
    expect(
      [...container.querySelectorAll(".admin-list-header span")].map((span) => span.textContent),
    ).toEqual(["Name", "Role", "Status", "Last sign-in", ""]);
    expect(text()).toContain("Active");
  });

  it("keeps selection distinct for actors that share a missing email", async () => {
    await renderWith([
      apiUser({ id: "a-1", displayName: "Agent One", type: "agent", email: null }),
      apiUser({ id: "a-2", displayName: "Agent Two", type: "agent", email: null }),
    ]);

    await click(checkbox("Select Agent One"));

    expect(checkbox("Select Agent One").checked).toBe(true);
    expect(checkbox("Select Agent Two").checked).toBe(false);
    expect(text()).toContain("1 selected");
  });

  it("shows a missing email as no address", async () => {
    await renderWith([apiUser({ id: "a-1", displayName: "Agent One", email: null })]);
    expect(text()).toContain("No email address");
  });

  it("searches the whole directory on the server, not just the loaded page", async () => {
    await renderWith(
      [
        apiUser({ id: "u-1", displayName: "Ada Front" }),
        apiUser({ id: "u-2", displayName: "Zed Behind" }),
      ],
      1,
    );
    expect(visibleUsers()).toEqual(["Ada Front"]);

    await typeSearch("zed");

    await waitFor(() => {
      expect(visibleUsers()).toEqual(["Zed Behind"]);
    });
    expect(requests.at(-1)?.searchParams.get("query")).toBe("zed");
  });

  it("debounces typing into one request rather than one per keystroke", async () => {
    await renderWith([apiUser({ id: "u-1", displayName: "Ada Front" })]);
    const before = requests.length;

    await typeSearch("a");
    await typeSearch("ad");
    await typeSearch("ada");

    await waitFor(() => {
      expect(requestedQueries().slice(before)).toEqual(["ada"]);
    });
  });

  it("says when nothing matches the filters", async () => {
    await renderWith([apiUser({ id: "u-1", displayName: "Ada Front" })]);
    await typeSearch("nobody");
    await waitFor(() => {
      expect(text()).toContain("No users match these filters");
    });
    expect(button("Clear filters")).toBeTruthy();
  });

  it("filters by status and asks the server to drop suspended accounts for Active", async () => {
    await renderWith([
      apiUser({ id: "u-1", displayName: "Live One" }),
      apiUser({
        id: "u-2",
        displayName: "Gone Two",
        status: "suspended",
        disabledAt: "2026-02-01T00:00:00Z",
      }),
    ]);
    expect(text()).toContain("Suspended");

    await selectValue("Status", "suspended");
    await waitFor(() => {
      expect(visibleUsers()).toEqual(["Gone Two"]);
    });

    await selectValue("Status", "active");
    await waitFor(() => {
      expect(visibleUsers()).toEqual(["Live One"]);
    });
    expect(requests.at(-1)?.searchParams.get("includeDisabled")).toBe("false");
  });

  it("shows people who have not joined yet as Invited and filters them", async () => {
    await renderWith([
      apiUser({ id: "u-1", displayName: "Live One" }),
      apiUser({ id: "u-2", displayName: "Pending Two", status: "invited" }),
    ]);
    expect(container.querySelector(".admin-user-row .chip.info")?.textContent).toBe("Invited");

    await selectValue("Status", "invited");
    await waitFor(() => {
      expect(visibleUsers()).toEqual(["Pending Two"]);
    });
    await selectValue("Status", "active");
    await waitFor(() => {
      expect(visibleUsers()).toEqual(["Live One"]);
    });
  });

  it("opens the invite dialog from the toolbar", async () => {
    await renderWith([apiUser({ id: "u-1", displayName: "Person" })]);
    await click(button("Invite people"));
    await waitFor(() => {
      expect(document.body.textContent).toContain("Send invitation");
    });
  });

  it("sends the account type to the server and ignores one it would reject", async () => {
    await renderWith([
      apiUser({ id: "u-1", displayName: "Person" }),
      apiUser({ id: "a-1", displayName: "Robot", type: "agent" }),
    ]);

    await selectValue("Account type", "agent");
    await waitFor(() => {
      expect(visibleUsers()).toEqual(["Robot"]);
    });
    expect(requests.at(-1)?.searchParams.get("type")).toBe("agent");

    routerSearch.current = { actorType: "not-a-type" };
    await render();
    await waitFor(() => {
      expect(visibleUsers()).toEqual(["Person", "Robot"]);
    });
    expect(
      container.querySelector<HTMLSelectElement>('select[aria-label="Account type"]')?.value,
    ).toBe("all");
  });

  it("offers the account actions in the row ⋮ menu", async () => {
    await renderWith([
      apiUser({ id: "u-1", displayName: "Person" }),
      apiUser({ id: "a-1", displayName: "Robot", type: "agent" }),
      apiUser({
        id: "u-2",
        displayName: "Gone",
        status: "suspended",
        disabledAt: "2026-02-01T00:00:00Z",
      }),
      apiUser({
        id: "u-3",
        displayName: "Former",
        status: "removed",
        disabledAt: "2026-01-15T00:00:00Z",
      }),
      apiUser({ id: "u-4", displayName: "Pending", status: "invited" }),
    ]);

    expect(await openRowMenu("Person")).toEqual([
      "Edit profile",
      "Mail addresses",
      "Reset sign-in verification",
      "Suspend user…",
      "Remove access…",
    ]);
    await key("Escape");
    expect(await openRowMenu("Robot")).toEqual(["Remove access…"]);
    await key("Escape");
    expect(await openRowMenu("Gone")).toEqual(["Edit profile", "Mail addresses", "Restore user…"]);
    await key("Escape");
    expect(await openRowMenu("Former")).toEqual(["Edit profile", "Mail addresses"]);
    await key("Escape");
    expect(await openRowMenu("Pending")).toEqual([
      "Edit profile",
      "Resend invitation",
      "Withdraw invitation…",
    ]);
  });

  it("shows the last sign-in instead of the date added", async () => {
    await renderWith([
      apiUser({ id: "u-1", displayName: "Signed In", lastSignInAt: "2026-01-02T09:00:00Z" }),
      apiUser({ id: "u-2", displayName: "Never Signed In" }),
    ]);
    const times = [...container.querySelectorAll(".admin-user-row time")].map((time) =>
      time.getAttribute("datetime"),
    );
    expect(times).toEqual(["2026-01-02T09:00:00Z"]);
    expect(text()).toContain("Never");
  });

  it("suspends and restores a person from the row menu after confirming", async () => {
    const users: ApiUser[] = [apiUser({ id: "u-1", displayName: "Person" })];
    mockUsers(users);
    const listUsers = fetchMock.getMockImplementation();
    const posts: string[] = [];
    fetchMock.mockImplementation((input, init) => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init?.method !== "POST") {
        return listUsers?.(input, init) ?? Promise.reject(new Error("No list mock"));
      }
      const path = new URL(href, "http://localhost").pathname;
      posts.push(path);
      const suspended = path.endsWith("/suspend");
      users[0] = {
        ...(users[0] as ApiUser),
        status: suspended ? "suspended" : "active",
        disabledAt: suspended ? "2026-03-01T00:00:00Z" : null,
      };
      return Promise.resolve(
        Response.json({ actorId: "u-1", status: users[0].status, changed: true }),
      );
    });
    await render();
    await waitFor(() => {
      expect(visibleUsers()).toEqual(["Person"]);
    });

    const choose = async (label: string) => {
      await openRowMenu("Person");
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (element) => element.textContent?.trim() === label,
      );
      await click(item as HTMLElement);
    };
    const confirmIn = async (label: string) => {
      let action: HTMLButtonElement | undefined;
      await waitFor(() => {
        const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
        action = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
          (element) => element.textContent?.trim() === label,
        );
        if (action === undefined) throw new Error(`No ${label} button in the confirmation`);
      });
      await click(action as HTMLButtonElement);
    };

    await choose("Suspend user…");
    await waitFor(() => {
      expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
        "signed out on every device",
      );
    });
    expect(posts).toEqual([]);
    await confirmIn("Suspend");
    await waitFor(() => {
      expect(posts).toEqual(["/v1/api/admin/users/u-1/suspend"]);
      expect(container.querySelector(".admin-user-row .chip.warning")?.textContent).toBe(
        "Suspended",
      );
    });

    await choose("Restore user…");
    await confirmIn("Restore");
    await waitFor(() => {
      expect(posts).toEqual(["/v1/api/admin/users/u-1/suspend", "/v1/api/admin/users/u-1/restore"]);
      expect(container.querySelector(".admin-user-row .chip.success")?.textContent).toBe("Active");
    });
  });

  it("opens only the chosen action, never the row, when a menu item is clicked", async () => {
    await renderWith([apiUser({ id: "u-1", displayName: "Person" })]);

    await openRowMenu("Person");
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (element) => element.textContent?.trim() === "Remove access…",
    );
    await click(item as HTMLElement);

    expect(routerSearch.current).not.toHaveProperty("user");
    expect(document.querySelector('[data-slot="side-sheet"]')).toBeNull();
  });

  it("resets sign-in verification from the row menu after confirming", async () => {
    await renderWith([apiUser({ id: "u-1", displayName: "Person" })]);
    const mockedUsers = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input, init) => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (href.includes("/mfa/reset")) {
        requests.push(new URL(href, "http://localhost"));
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return mockedUsers?.(input, init) ?? Promise.reject(new Error("unmocked"));
    });

    await openRowMenu("Person");
    await selectMenuItem("Reset sign-in verification");
    const confirm = [...document.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === "Reset",
    );
    expect(document.body.textContent).toContain("Reset sign-in verification for Person?");
    await click(confirm as HTMLButtonElement);

    await waitFor(() => {
      expect(requests.some((url) => url.pathname.endsWith("/users/u-1/mfa/reset"))).toBe(true);
    });
  });

  it("opens a person's details in a side sheet and keeps it in the URL", async () => {
    await renderWith([apiUser({ id: "u-1", displayName: "Person", scopes: ["admin.audit"] })]);

    const row = container.querySelector<HTMLElement>('[role="row"]');
    await click(row as HTMLElement);

    expect(routerSearch.current).toMatchObject({ user: "u-1" });
    await waitFor(() => {
      expect(document.querySelector('[data-slot="side-sheet"]')?.textContent).toContain(
        "admin.audit",
      );
    });
    const sheet = document.querySelector('[data-slot="side-sheet"]');
    expect(sheet?.textContent).toContain("Account typeUser");
    expect(sheet?.querySelector('[aria-label="Copy user ID"]')).not.toBeNull();
  });

  it("acts on the selection: copies the selected email addresses", async () => {
    await renderWith([
      apiUser({ id: "u-1", displayName: "One" }),
      apiUser({ id: "u-2", displayName: "Two" }),
    ]);

    await click(checkbox("Select One"));
    await click(checkbox("Select Two"));
    expect(text()).toContain("2 selected");

    await click(button("Copy email addresses"));
    expect(clipboardWrite).toHaveBeenCalledWith("u-1@helix.local, u-2@helix.local");
  });

  it("selects every listed user from the header checkbox", async () => {
    await renderWith([
      apiUser({ id: "u-1", displayName: "One" }),
      apiUser({ id: "u-2", displayName: "Two" }),
    ]);

    await click(checkbox("Select all users"));
    expect(text()).toContain("2 selected");
    expect(checkbox("Select One").checked).toBe(true);
    expect(checkbox("Select Two").checked).toBe(true);
  });

  it("loads the next page on demand", async () => {
    await renderWith(
      [apiUser({ id: "u-1", displayName: "One" }), apiUser({ id: "u-2", displayName: "Two" })],
      1,
    );
    expect(text()).toContain("1 user loaded");

    await click(button("Load more"));

    await waitFor(() => {
      expect(visibleUsers()).toEqual(["One", "Two"]);
    });
    expect(requests.at(-1)?.searchParams.get("cursor")).toBe("1");
    expect(text()).toContain("2 users");
    expect(buttonLabels()).not.toContain("Load more");
  });

  it("reports a failed directory load with a retry instead of an empty list", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ error: "Admin users permission denied." }, { status: 403 })),
    );
    await render();

    await waitFor(() => {
      expect(text()).toContain("Users couldn't be loaded");
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(text()).not.toContain("No users");
    expect(text()).not.toContain("0 users");
    expect(button("Retry").disabled).toBe(false);
  });

  it("shows a skeleton and no count while the directory is loading", async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    await render();

    expect(container.querySelector('[data-slot="skeleton"]')?.getAttribute("aria-label")).toBe(
      "Loading users",
    );
    expect(text()).not.toContain("0 users");
  });

  it("shows an empty state once the directory says it is empty", async () => {
    mockUsers([]);
    await render();

    await waitFor(() => {
      expect(text()).toContain("No users yet");
    });
    expect(text()).toContain("0 users");
  });
});

describe("prefetchAdminDirectoryQuery", () => {
  it("warms the key the section reads, not a neighbouring one", async () => {
    const captured: unknown[] = [];
    await prefetchAdminDirectoryQuery({
      ensureInfiniteQueryData: (options) => {
        captured.push(options.queryKey);
        return Promise.resolve();
      },
    });

    // A prefetch under a different key is a wasted request, so this pins it to
    // the input the section mounts with: full page, no search, disabled shown.
    expect(captured).toEqual([
      adminUsersInfiniteQueryOptions({
        limit: 250,
        query: "",
        type: "",
        includeDisabled: true,
      }).queryKey,
    ]);
  });

  it("contains its own failure so navigation is never blocked", async () => {
    await expect(
      prefetchAdminDirectoryQuery({
        ensureInfiniteQueryData: () => Promise.reject(new Error("directory unavailable")),
      }),
    ).resolves.toBeUndefined();
  });
});
