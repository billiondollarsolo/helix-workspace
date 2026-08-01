// @vitest-environment jsdom

/* Admin › People › Users — directory projection and controls.
 *
 * The console-wide suite in `admin-console.test.tsx` covers the section's
 * place in the shell. These cover the section's own contract: the role
 * derivation (which the platform authorizes per dotted scope, not by an exact
 * `admin` match), selection identity, and the honesty of the controls. */

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminUsers } from "@/features/admin/sections/users";
import { adminScopesOf, roleForActor } from "@/features/admin/admin-console-data";

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

  function mockUsers(users: readonly ApiUser[], nextCursor: string | null = null) {
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({ users, nextCursor })));
  }

  /** Polls with real timers — react-query settles over several ticks, so a
   *  fixed number of microtask flushes is racy. */
  async function waitFor(assertion: () => void, timeout = 1000): Promise<void> {
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

  async function renderWith(users: readonly ApiUser[], nextCursor: string | null = null) {
    mockUsers(users, nextCursor);
    await render();
    await waitFor(() => {
      expect(visibleUsers()).toHaveLength(users.length);
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

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    clipboardWrite = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
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

    await selectValue("Filter by role", "Scoped admin");
    expect(visibleUsers()).toEqual(["Ada Auditor"]);

    await selectValue("Filter by role", "Admin");
    expect(visibleUsers()).toEqual(["Olu Owner"]);

    await selectValue("Filter by role", "Member");
    expect(visibleUsers()).toEqual(["Pat Plain"]);
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
    // matched every address-less actor as if it were their address.
    await typeSearch("—");
    expect(visibleUsers()).toEqual([]);
    expect(text()).toContain("No users match the current filters.");
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
    expect(visibleUsers()).toEqual(["Off Person"]);
  });

  it("hides the actor-type filter when every actor is the same type", async () => {
    await renderWith([apiUser({ id: "u-1" }), apiUser({ id: "u-2" })]);
    expect(container.querySelector('select[aria-label="Filter by actor type"]')).toBeNull();
  });

  it("offers the actor-type filter once the directory holds more than one type", async () => {
    await renderWith([apiUser({ id: "u-1" }), apiUser({ id: "a-1", type: "agent", email: null })]);

    expect(container.querySelector('select[aria-label="Filter by actor type"]')).not.toBeNull();
    await selectValue("Filter by actor type", "agent");
    expect(visibleUsers()).toEqual(["User a-1"]);
  });

  it("stops applying the type filter once its control is no longer on screen", async () => {
    await renderWith([apiUser({ id: "u-1" }), apiUser({ id: "a-1", type: "agent", email: null })]);
    await selectValue("Filter by actor type", "agent");
    expect(visibleUsers()).toEqual(["User a-1"]);

    // The agent leaves the directory, so the type select unmounts. A filter the
    // operator can no longer see must not keep hiding the remaining rows.
    mockUsers([apiUser({ id: "u-1" })]);
    await act(async () => {
      await queryClient.invalidateQueries();
    });

    await waitFor(() => {
      expect(container.querySelector('select[aria-label="Filter by actor type"]')).toBeNull();
    });
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

    await click(expander);

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

  it("says so when the directory is longer than the page it loaded", async () => {
    await renderWith([apiUser({ id: "u-1" })], "cursor-2");

    expect(text()).toContain("Showing the first 250 accounts");
    expect(text()).toContain("apply only to these rows");
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
