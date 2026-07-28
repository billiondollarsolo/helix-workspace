// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminUsersQueryOptions,
  AdminUsersList,
  listAdminUsers,
  prefetchAdminUsersQuery,
  type AdminUsersListResponse,
} from "./admin-users";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("AdminUsersList", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let alertMock: ReturnType<typeof vi.fn>;
  let confirmMock: ReturnType<typeof vi.fn>;
  let promptMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    fetchMock = vi.fn<typeof fetch>();
    alertMock = vi.fn();
    confirmMock = vi.fn();
    promptMock = vi.fn();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("alert", alertMock);
    vi.stubGlobal("confirm", confirmMock);
    vi.stubGlobal("prompt", promptMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders admin user rows with TanStack table semantics", async () => {
    fetchMock.mockResolvedValue(Response.json(adminUsersPage({ nextCursor: "cursor-2" })));

    renderAdminUsers();
    await waitForText("Mina Jay");

    const table = tableByLabel("Admin users");
    const headers = Array.from(table.querySelectorAll('[role="columnheader"]')).map(
      (header) => header.textContent,
    );
    expect(headers).toEqual(["User", "Type", "Scopes", "Status", "Created", "Updated", "ID"]);
    expect(table.textContent).toContain("mina@example.com");
    expect(table.textContent).toContain("admin.users");
    expect(table.textContent).toContain("Disabled");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/users?includeDisabled=false&limit=50");
    expectNoNativeDialogs();
  });

  it("applies filters through backend query params", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(adminUsersPage({ nextCursor: "cursor-2" })))
      .mockResolvedValueOnce(Response.json({ users: [adminUser()], nextCursor: null }));

    renderAdminUsers();
    await waitForText("Mina Jay");
    await setInputValue("User search query", " mina@example.com ");
    await setSelectValue("User type filter", "user");
    await clickCheckbox("Include disabled users");
    await clickButton("Apply");

    await waitFor(() =>
      expect(fetchMock.mock.calls[1]?.[0]).toBe(
        "/api/admin/users?query=mina%40example.com&type=user&includeDisabled=true&limit=50",
      ),
    );
    expectNoNativeDialogs();
  });

  it("requests the next cursor page and preserves active filters", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(adminUsersPage({ nextCursor: "cursor-2" })))
      .mockResolvedValueOnce(Response.json(adminUsersPage({ nextCursor: "cursor-2" })))
      .mockResolvedValueOnce(
        Response.json({ users: [adminUser({ id: "page-2-user" })], nextCursor: null }),
      );

    renderAdminUsers();
    await waitForText("Mina Jay");
    await setInputValue("User search query", "mina");
    await clickButton("Apply");
    await waitFor(() =>
      expect(fetchMock.mock.calls[1]?.[0]).toBe(
        "/api/admin/users?query=mina&includeDisabled=false&limit=50",
      ),
    );

    await waitFor(() => expect(buttonByText("Next page").disabled).toBe(false));
    await clickButton("Next page");

    await waitFor(() =>
      expect(fetchMock.mock.calls[2]?.[0]).toBe(
        "/api/admin/users?query=mina&includeDisabled=false&limit=50&cursor=cursor-2",
      ),
    );
    expectNoNativeDialogs();
  });

  it("surfaces backend errors without native dialogs", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "admin scope required" }, { status: 403 }));

    renderAdminUsers();

    await waitForText("admin scope required");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("admin scope required");
    expectNoNativeDialogs();
  });

  function renderAdminUsers() {
    act(() => {
      root.render(
        createElement(QueryClientProvider, { client: queryClient }, createElement(AdminUsersList)),
      );
    });
  }

  function tableByLabel(label: string): HTMLElement {
    const table = container.querySelector(`[role="table"][aria-label="${label}"]`);
    if (!(table instanceof HTMLElement)) {
      throw new Error(`Table not found: ${label}`);
    }
    return table;
  }

  async function clickButton(name: string) {
    const button = buttonByText(name);
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  function buttonByText(name: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes(name),
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Button not found: ${name}`);
    }
    return button;
  }

  async function clickCheckbox(label: string) {
    const input = container.querySelector(`input[type="checkbox"][aria-label="${label}"]`);
    if (!(input instanceof HTMLInputElement)) {
      throw new Error(`Checkbox not found: ${label}`);
    }
    act(() => {
      input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function setInputValue(label: string, value: string) {
    const input = container.querySelector(`input[aria-label="${label}"]`);
    if (!(input instanceof HTMLInputElement)) {
      throw new Error(`Input not found: ${label}`);
    }
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
        ?.set as ((this: HTMLInputElement, value: string) => void) | undefined;
      valueSetter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function setSelectValue(label: string, value: string) {
    const select = container.querySelector(`select[aria-label="${label}"]`);
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error(`Select not found: ${label}`);
    }
    act(() => {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function waitForText(text: string) {
    await waitFor(() => expect(container.textContent).toContain(text));
  }

  async function waitFor(assertion: () => void | Promise<void>) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await act(async () => {
          await Promise.resolve();
        });
        await assertion();
        return;
      } catch (error) {
        lastError = error;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Timed out waiting for assertion.");
  }

  function expectNoNativeDialogs() {
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  }
});

describe("admin users API helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds list params and validates the response shape", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(adminUsersPage({})));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: vi.fn(() => null) },
    });

    await expect(
      listAdminUsers({
        cursor: " cursor-3 ",
        includeDisabled: true,
        limit: 25,
        query: " Mina ",
        type: " user ",
      }),
    ).resolves.toEqual(adminUsersPage({}));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/admin/users?query=Mina&type=user&includeDisabled=true&limit=25&cursor=cursor-3",
    );
  });

  it("prefetches the default admin users query with contained errors", async () => {
    const ensureQueryData = vi
      .fn<(options: ReturnType<typeof adminUsersQueryOptions>) => Promise<unknown>>()
      .mockRejectedValue(new Error("users unavailable"));

    await expect(prefetchAdminUsersQuery({ ensureQueryData })).resolves.toBeUndefined();

    expect(ensureQueryData).toHaveBeenCalledTimes(1);
  });
});

function adminUsersPage(input: { readonly nextCursor?: string | null }): AdminUsersListResponse {
  return {
    users: [
      adminUser(),
      adminUser({
        disabledAt: "2026-05-19T10:00:00.000Z",
        displayName: "",
        email: "disabled@example.com",
        id: "22222222-2222-4222-8222-222222222222",
        scopes: [],
        type: "agent",
      }),
    ],
    nextCursor: input.nextCursor ?? null,
  };
}

function adminUser(
  overrides: Partial<AdminUsersListResponse["users"][number]> = {},
): AdminUsersListResponse["users"][number] {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    orgId: "99999999-9999-4999-8999-999999999999",
    type: "user",
    email: "mina@example.com",
    displayName: "Mina Jay",
    scopes: ["admin.users", "workspace.read"],
    disabledAt: null,
    createdAt: "2026-05-18T12:00:00.000Z",
    updatedAt: "2026-05-20T13:30:00.000Z",
    ...overrides,
  };
}
