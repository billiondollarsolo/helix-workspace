// @vitest-environment jsdom

/* Admin › People › Users — directory projection and controls.
 *
 * The console-wide suite in `admin-console.test.tsx` covers the section's
 * place in the shell. These cover the section's own contract: the role
 * derivation (which the platform authorizes per dotted scope, not by an exact
 * `admin` match), selection identity, and the honesty of the controls.
 *
 * The fetch double below answers `query`, `type`, `includeDisabled` and the
 * cursor the way the route does, because search is now the server's job: a test
 * whose double ignored those params would pass while the directory searched one
 * page and told a 10k-actor workspace that nobody matched. */

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminUsers, prefetchAdminDirectoryQuery } from "@/features/admin/sections/users";
import { adminUsersInfiniteQueryOptions } from "@/features/admin/admin-users";
import { adminScopesOf, roleForActor } from "@/features/admin/admin-console-data";

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
  readonly disabledAt: string | null;
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
    disabledAt: null,
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

  /** Body rows of the directory table — accounts plus any open detail row. */
  function tableRows(): readonly HTMLTableRowElement[] {
    return [
      ...container.querySelectorAll<HTMLTableRowElement>(
        'table[aria-label="User directory"] tbody tr',
      ),
    ];
  }

  /** The role chip text of each rendered row, in row order. */
  function visibleRoles(): readonly string[] {
    return [...container.querySelectorAll(".panel .chip")]
      .map((chip) => chip.textContent?.trim() ?? "")
      .filter((value) => /^(Admin|Scoped admin|Member)/u.test(value));
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
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Filter users"]');
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

  it("labels a scoped administrator as an admin and matches the Admin-family filter", async () => {
    await renderWith([
      apiUser({ id: "u-auditor", displayName: "Ada Auditor", scopes: ["admin.audit"] }),
      apiUser({ id: "u-owner", displayName: "Olu Owner", scopes: ["admin.*"] }),
      apiUser({ id: "u-plain", displayName: "Pat Plain", scopes: ["mail.read"] }),
    ]);

    // Row order follows the API. The auditor holds only `admin.audit`, and
    // the count beside the chip is what separates them from a broader admin.
    expect(visibleRoles()).toEqual(["Scoped admin · 1", "Admin", "Member"]);

    // Role is derived from scopes and the endpoint has no scope filter, so this
    // one stays a browser pass over the loaded rows.
    await selectValue("Filter by role", "Scoped admin");
    expect(visibleUsers()).toEqual(["Ada Auditor"]);

    await selectValue("Filter by role", "Admin");
    expect(visibleUsers()).toEqual(["Olu Owner"]);

    await selectValue("Filter by role", "Member");
    expect(visibleUsers()).toEqual(["Pat Plain"]);
  });

  it("renders the directory as a named table rather than a stack of divs", async () => {
    await renderWith([
      apiUser({ id: "u-1", displayName: "One" }),
      apiUser({ id: "u-2", displayName: "Two" }),
    ]);

    // The pseudo-table it replaces gave assistive tech anonymous boxes where the
    // semantics said "table", and no accessible name at all.
    const table = container.querySelector<HTMLTableElement>('table[aria-label="User directory"]');
    expect(table).not.toBeNull();
    expect([...(table?.querySelectorAll("thead th") ?? [])].map((th) => th.textContent)).toEqual([
      "",
      "User",
      "Role",
      "Type",
      "Status",
      "Details",
    ]);
    expect(tableRows()).toHaveLength(2);
  });

  it("keeps selection distinct for actors that share a missing email", async () => {
    await renderWith([
      apiUser({ id: "a-1", displayName: "Agent One", type: "agent", email: null }),
      apiUser({ id: "a-2", displayName: "Agent Two", type: "agent", email: null }),
    ]);

    await click(checkbox("Select Agent One"));

    expect(checkbox("Select Agent One").checked).toBe(true);
    // The bug: both rows keyed on "—", so ticking one ticked both.
    expect(checkbox("Select Agent Two").checked).toBe(false);
    expect(text()).toContain("1 selected");
  });

  it("renders a missing email as unknown rather than a matchable placeholder", async () => {
    await renderWith([apiUser({ id: "a-1", displayName: "Agent One", email: null })]);

    expect(text()).toContain("No email address");

    // The old projection stored "—" as the email, so searching the placeholder
    // matched every address-less actor as if it were their address. The search
    // is server-side now, and the endpoint has no such value either.
    await typeSearch("—");
    await waitFor(() => {
      expect(text()).toContain("No users match the current filters.");
    });
    expect(visibleUsers()).toEqual([]);
  });

  it("searches the whole directory, not just the page already loaded", async () => {
    // The reported bug: one 250-row page filtered in the browser, so anyone
    // outside it was reported as "no users match". `Zed` is on the second page.
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
      expect(requests.at(-1)?.searchParams.get("query")).toBe("ada");
    });
    // One extra request in total: the intermediate values never left.
    expect(requests.length).toBe(before + 1);
    expect(requestedQueries()).not.toContain("ad");
  });

  it("offers no Invited status, because the projection cannot produce one", async () => {
    await renderWith([apiUser({ id: "u-1" })]);

    const options = [
      ...container.querySelectorAll<HTMLOptionElement>(
        'select[aria-label="Filter by status"] option',
      ),
    ].map((option) => option.value);
    expect(options).toEqual(["all", "active", "suspended"]);
  });

  it("filters by status using the disabledAt projection", async () => {
    await renderWith([
      apiUser({ id: "u-live", displayName: "Live Person" }),
      apiUser({ id: "u-off", displayName: "Off Person", disabledAt: "2026-05-01T00:00:00Z" }),
    ]);

    await selectValue("Filter by status", "suspended");
    await waitFor(() => {
      expect(visibleUsers()).toEqual(["Off Person"]);
    });
  });

  it("asks the server to drop suspended accounts when only active ones are wanted", async () => {
    // `includeDisabled` is the API's only status lever, so Active is answered
    // over the whole workspace instead of by hiding rows that were fetched.
    await renderWith([
      apiUser({ id: "u-live", displayName: "Live Person" }),
      apiUser({ id: "u-off", displayName: "Off Person", disabledAt: "2026-05-01T00:00:00Z" }),
    ]);
    expect(requests[0]?.searchParams.get("includeDisabled")).toBe("true");

    await selectValue("Filter by status", "active");

    await waitFor(() => {
      expect(visibleUsers()).toEqual(["Live Person"]);
    });
    expect(requests.at(-1)?.searchParams.get("includeDisabled")).toBe("false");
  });

  it("hides the actor-type filter when every actor is the same type", async () => {
    await renderWith([apiUser({ id: "u-1" }), apiUser({ id: "u-2" })]);
    expect(container.querySelector('select[aria-label="Filter by actor type"]')).toBeNull();
  });

  it("sends the actor type to the server once more than one type is present", async () => {
    await renderWith([apiUser({ id: "u-1" }), apiUser({ id: "a-1", type: "agent", email: null })]);

    expect(container.querySelector('select[aria-label="Filter by actor type"]')).not.toBeNull();
    await selectValue("Filter by actor type", "agent");

    await waitFor(() => {
      expect(visibleUsers()).toEqual(["User a-1"]);
    });
    expect(requests.at(-1)?.searchParams.get("type")).toBe("agent");
  });

  it("keeps the type filter on screen while it applies, so it can always be cleared", async () => {
    await renderWith([apiUser({ id: "u-1" }), apiUser({ id: "a-1", type: "agent", email: null })]);
    await selectValue("Filter by actor type", "agent");
    await waitFor(() => {
      expect(visibleUsers()).toEqual(["User a-1"]);
    });

    // The filter now narrows the server result set, so the loaded rows are all
    // one type by construction. A select that hid itself on that basis would
    // leave a filter applied with no control on screen to clear it.
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Filter by actor type"]',
    );
    expect(select).not.toBeNull();
    expect(select?.value).toBe("agent");

    await selectValue("Filter by actor type", "all");
    await waitFor(() => {
      expect(visibleUsers()).toEqual(["User u-1", "User a-1"]);
    });
  });

  it("ignores an actor type the endpoint would reject", async () => {
    // A hand-edited or stale `?actorType=` must not turn into a 400 that reads
    // as a broken directory; it is read as "all".
    routerSearch.current = { actorType: "wizard" };
    await renderWith([apiUser({ id: "u-1" })]);

    expect(requests[0]?.searchParams.get("type")).toBeNull();
    expect(visibleUsers()).toEqual(["User u-1"]);
  });

  it("discloses the scopes behind a role from the row expander", async () => {
    await renderWith([
      apiUser({ id: "u-1", displayName: "Ada Auditor", scopes: ["mail.read", "admin.audit"] }),
    ]);

    const expander = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Details for Ada Auditor"]',
    );
    if (!expander) {
      throw new Error("Row expander not found");
    }
    expect(expander.getAttribute("aria-expanded")).toBe("false");
    // Collapsed rows must not leak the detail into the table.
    expect(text()).not.toContain("Actor ID");
    expect(tableRows()).toHaveLength(1);

    await click(expander);

    // The disclosure is a second row of the same table, not a panel that left
    // the table — and it is the row `aria-controls` points at.
    expect(tableRows()).toHaveLength(2);
    expect(tableRows()[1]?.contains(container.querySelector(`#user-detail-u-1`))).toBe(true);
    expect(expander.getAttribute("aria-controls")).toBe("user-detail-u-1");
    expect(expander.getAttribute("aria-expanded")).toBe("true");
    expect(text()).toContain("Actor ID");
    expect(text()).toContain("admin.audit");
    // Only the admin scopes belong to the role, not every scope held.
    expect(text()).not.toContain("mail.read");
  });

  it("copies the actor id from the row detail", async () => {
    await renderWith([apiUser({ id: "u-1", displayName: "Ada Auditor" })]);

    const expander = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Details for Ada Auditor"]',
    );
    await click(expander as HTMLButtonElement);
    await click(button("Copy ID"));

    expect(clipboardWrite).toHaveBeenCalledWith("u-1");
  });

  it("gives the bulk bar a working action and disables the ones with no endpoint", async () => {
    await renderWith([
      apiUser({ id: "u-1", displayName: "One", email: "one@helix.local" }),
      apiUser({ id: "u-2", displayName: "Two", email: "two@helix.local" }),
    ]);

    await click(checkbox("Select all users"));
    expect(text()).toContain("2 selected");

    await click(button("Copy 2 emails"));
    expect(clipboardWrite).toHaveBeenCalledWith("one@helix.local, two@helix.local");

    // Present, but honest about why they cannot run.
    const changeRole = button("Change role");
    const suspend = button("Suspend");
    expect(changeRole.disabled).toBe(true);
    expect(suspend.disabled).toBe(true);
    for (const control of [changeRole, suspend]) {
      expect(control.getAttribute("title")).toContain("read-only");
      const describedBy = control.getAttribute("aria-describedby");
      expect(describedBy).not.toBeNull();
      expect(container.querySelector(`#${String(describedBy)}`)?.textContent).toContain(
        "read-only",
      );
    }

    await click(button("Clear selection"));
    expect(text()).not.toContain("2 selected");
  });

  it("counts only rows the action would actually affect", async () => {
    await renderWith([
      apiUser({ id: "u-1", displayName: "One", scopes: ["admin.audit"] }),
      apiUser({ id: "u-2", displayName: "Two" }),
    ]);

    await click(checkbox("Select all users"));
    expect(text()).toContain("2 selected");

    // The bug: selection outlived the rows, so the bar counted — and copied —
    // accounts that were no longer on screen.
    await selectValue("Filter by role", "Scoped admin");
    await waitFor(() => {
      expect(visibleUsers()).toEqual(["One"]);
    });
    expect(text()).toContain("1 selected");
    expect(text()).not.toContain("2 selected");
    expect(buttonLabels()).toContain("Copy 1 email");
  });

  it("says the selection covers loaded rows only while pages remain", async () => {
    await renderWith(
      [apiUser({ id: "u-1", displayName: "One" }), apiUser({ id: "u-2", displayName: "Two" })],
      1,
    );

    await click(checkbox("Select all users"));
    expect(text()).toContain("1 selected");
    expect(text()).toContain("from the loaded rows only");
    expect(checkbox("Select all users").getAttribute("title")).toContain("not yet loaded");
  });

  it("disables Import CSV and Invite users with a stated reason", async () => {
    await renderWith([apiUser({ id: "u-1" })]);

    for (const label of ["Import CSV", "Invite users"]) {
      const control = button(label);
      expect(control.disabled).toBe(true);
      expect(control.getAttribute("title")).toContain("read-only");
      const describedBy = control.getAttribute("aria-describedby");
      expect(container.querySelector(`#${String(describedBy)}`)?.textContent).toContain(
        "read-only",
      );
    }
  });

  it("exports the rows currently filtered, not the whole page", async () => {
    // jsdom implements neither, so they are defined rather than replaced —
    // swapping the whole URL global breaks everything else that resolves URLs.
    // Restored below so the stubs cannot leak into the next test.
    const original = {
      create: URL.createObjectURL as typeof URL.createObjectURL | undefined,
      revoke: URL.revokeObjectURL as typeof URL.revokeObjectURL | undefined,
    };
    const createObjectURL = vi.fn(() => "blob:users");
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;

    const blobs: Blob[] = [];
    createObjectURL.mockImplementation(((blob: Blob) => {
      blobs.push(blob);
      return "blob:users";
    }) as unknown as () => string);

    await renderWith([
      apiUser({ id: "u-1", displayName: "One", scopes: ["admin.audit"] }),
      apiUser({ id: "u-2", displayName: "Two" }),
    ]);

    await selectValue("Filter by role", "Scoped admin");
    const exportButton = button("Export CSV");
    expect(exportButton.disabled).toBe(false);
    await click(exportButton);

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    const csv = await blobs[0]?.text();
    expect(csv).toContain("One");
    expect(csv).toContain("admin.audit");
    expect(csv).not.toContain("Two");

    URL.createObjectURL = original.create as typeof URL.createObjectURL;
    URL.revokeObjectURL = original.revoke as typeof URL.revokeObjectURL;
  });

  it("says more pages remain, and never calls the loaded rows the workspace total", async () => {
    await renderWith(
      [apiUser({ id: "u-1", displayName: "One" }), apiUser({ id: "u-2", displayName: "Two" })],
      1,
    );

    // The old banner claimed search covered only the loaded rows; that is now
    // false. What replaces it may not claim completeness either.
    expect(text()).not.toContain("Showing the first 250 accounts");
    expect(text()).toContain("the server has more");
    expect(text()).toContain("1 loaded");
    expect(text()).not.toContain("1 user");
  });

  it("calls loaded what was loaded, not what the browser filter left", async () => {
    await renderWith(
      [
        apiUser({ id: "u-1", displayName: "One", scopes: ["admin.audit"] }),
        apiUser({ id: "u-2", displayName: "Two" }),
        apiUser({ id: "u-3", displayName: "Three" }),
      ],
      2,
    );

    // The role pass runs after the fetch, so counting it made the header read
    // "1 loaded" while the banner one line below said 2 accounts are loaded —
    // two numbers on the same screen contradicting each other.
    await selectValue("Filter by role", "Scoped admin");
    await waitFor(() => {
      expect(visibleUsers()).toEqual(["One"]);
    });

    expect(text()).toContain("1 shown of 2 loaded");
    expect(text()).toContain("2 accounts are loaded");
    expect(text()).not.toContain("1 loaded");
  });

  it("loads the next page on demand and stops saying more remain", async () => {
    await renderWith(
      [apiUser({ id: "u-1", displayName: "One" }), apiUser({ id: "u-2", displayName: "Two" })],
      1,
    );

    await click(button("Load more"));

    await waitFor(() => {
      expect(visibleUsers()).toEqual(["One", "Two"]);
    });
    expect(requests.at(-1)?.searchParams.get("cursor")).toBe("1");
    expect(text()).not.toContain("the server has more");
    expect(text()).toContain("2 users");
    expect(buttonLabels()).not.toContain("Load more");
  });

  it("reports a failed directory load with a retry instead of an empty table", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ error: "Admin users permission denied." }, { status: 403 })),
    );
    await render();

    await waitFor(() => {
      expect(text()).toContain("The directory is unavailable");
    });
    // A refused request must not read as an empty workspace.
    expect(text()).toContain("Could not load the directory.");
    expect(text()).not.toContain("No users match the current filters.");
    expect(button("Retry").disabled).toBe(false);
  });

  it("prints no user count when the directory was refused", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ error: "Admin users permission denied." }, { status: 403 })),
    );
    await render();

    await waitFor(() => {
      expect(text()).toContain("The directory is unavailable");
    });
    // The header used to count the `?? []` fallback, so a 403 was reported as a
    // measured, empty workspace — and Overview reads the same directory for its
    // own figure, so the zero appeared twice.
    expect(text()).not.toContain("0 users");
    expect(text()).toContain("count unavailable");
  });

  it("prints no user count while the directory is still loading", async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    await render();

    expect(text()).toContain("counting…");
    expect(text()).not.toContain("0 users");
    expect(text()).toContain("Loading users…");
  });

  it("counts an empty directory only once the directory said it was empty", async () => {
    mockUsers([]);
    await render();

    // Zero is a real reading here: the request answered with no accounts. The
    // fix must not swallow a genuine empty directory along with the fake one.
    await waitFor(() => {
      expect(text()).toContain("0 users");
    });
    expect(text()).not.toContain("count unavailable");
    expect(text()).not.toContain("counting…");
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
