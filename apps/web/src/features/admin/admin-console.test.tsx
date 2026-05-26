// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellOverlayContext } from "@/components/shell";
import { AdminConsole } from "./admin-console";

/** TopBar calls `sessionUserQueryOptions()` → fetch("/api/auth/get-session").
 * That would consume the per-test fetchMock Response before the AdminUsers
 * query reads it, so we stub the session query to a resolved null instead. */
vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    sessionUserQueryOptions: () => ({
      queryKey: ["auth", "session"],
      queryFn: () => Promise.resolve(null),
      staleTime: 30_000,
      throwOnError: false,
    }),
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const overlayApi = {
  openNotifications: vi.fn(),
  openPalette: vi.fn(),
  openSettings: vi.fn(),
};

const apiUsers = {
  users: [
    {
      id: "u-1",
      orgId: "org-1",
      type: "human",
      email: "mira@helix.io",
      displayName: "Mira Okafor",
      scopes: ["admin"],
      disabledAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      id: "u-2",
      orgId: "org-1",
      type: "human",
      email: "marcus@helix.io",
      displayName: "Marcus Bell",
      scopes: [],
      disabledAt: "2026-05-01T00:00:00Z",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-05-01T00:00:00Z",
    },
  ],
  nextCursor: null,
};

function mockJsonFetch(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, payload: unknown): void {
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

/** Set a React-controlled input's value via the native prototype setter so
 *  the synthetic `input` event reflects the new value. */
function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
    input,
    value,
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function waitFor(assertion: () => void, timeout = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        assertion();
        resolve();
      } catch (error) {
        if (Date.now() - start > timeout) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        setTimeout(tick, 10);
      }
    };
    tick();
  });
}

describe("AdminConsole", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  function render(node: ReactNode): Promise<void> {
    return act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(ShellOverlayContext.Provider, { value: overlayApi }, node),
        ),
      );
      return Promise.resolve();
    });
  }

  function clickButton(label: string): Promise<void> {
    const button = [...container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === label,
    );
    if (!button) {
      throw new Error(`Button "${label}" not found`);
    }
    return act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
    });
    vi.stubGlobal("fetch", fetchMock);
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

  it("renders the Overview placeholder by default (telemetry not yet wired)", async () => {
    mockJsonFetch(fetchMock, apiUsers);

    await render(createElement(AdminConsole));

    expect(container.textContent).toContain("Workspace overview");
    expect(container.textContent).toContain("Telemetry not yet wired");
  });

  it("navigates to each admin section from the sidebar", async () => {
    mockJsonFetch(fetchMock, apiUsers);

    await render(createElement(AdminConsole));

    await clickButton("Groups & OUs");
    expect(container.textContent).toContain("Organizational Units");

    await clickButton("Security");
    // The Security section now renders real policies only. With fetch mocked
    // to return the users payload, the policies query errors and the section
    // surfaces its error banner rather than fabricated reference cards.
    await waitFor(() => {
      expect(container.textContent).toContain("Security policies unavailable");
    });

    await clickButton("Apps");
    await waitFor(() => {
      expect(container.textContent).toContain("App permissions");
    });

    await clickButton("Billing");
    // The billing section now renders real-data only. With fetch mocked to
    // return the users payload, the billing account query errors and the
    // section renders its error banner instead of fabricated rows.
    await waitFor(() => {
      expect(container.textContent).toContain("Billing & licenses");
    });

    await clickButton("Settings");
    await waitFor(() => {
      expect(container.textContent).toContain("Tenant settings");
    });

    await clickButton("Audit log");
    // The audit section now renders the live AuditLogList component, which
    // fetches from /api/admin/audit-log. The mocked fetch returns the users
    // payload here, so we assert on stable surface chrome rather than rows.
    await waitFor(() => {
      expect(container.textContent).toContain("Recent immutable activity records");
    });

    await clickButton("Domain");
    // The Domain section now renders real domains only. With fetch mocked to
    // return the users payload, the domains query errors and the section
    // surfaces its error banner rather than fabricated DNS records.
    await waitFor(() => {
      expect(container.textContent).toContain("Domains unavailable");
    });
  });

  it("wires the Users table to the admin users API", async () => {
    mockJsonFetch(fetchMock, apiUsers);

    await render(createElement(AdminConsole));
    await clickButton("Users");

    await waitFor(() => {
      expect(container.textContent).toContain("Mira Okafor");
    });
    // disabledAt -> suspended status projection
    expect(container.textContent).toContain("suspended");
    const requestedUsers = fetchMock.mock.calls.some((call) => {
      const input = call[0];
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input instanceof Request
              ? input.url
              : "";
      return url.includes("/api/admin/users");
    });
    expect(requestedUsers).toBe(true);
  });

  it("shows the empty-state row when the users API returns no rows", async () => {
    mockJsonFetch(fetchMock, { users: [], nextCursor: null });

    await render(createElement(AdminConsole));
    await clickButton("Users");

    await waitFor(() => {
      expect(container.textContent).toContain("No users match the current filters.");
    });
  });

  it("filters users by search query (using real API rows)", async () => {
    mockJsonFetch(fetchMock, apiUsers);

    await render(createElement(AdminConsole));
    await clickButton("Users");

    await waitFor(() => {
      expect(container.textContent).toContain("Mira Okafor");
      expect(container.textContent).toContain("Marcus Bell");
    });

    const search = container.querySelector<HTMLInputElement>('input[aria-label="Filter users"]');
    if (!search) {
      throw new Error("Search input not found");
    }
    await act(() => {
      setInputValue(search, "marcus");
      return Promise.resolve();
    });

    expect(container.textContent).toContain("Marcus Bell");
    expect(container.textContent).not.toContain("Mira Okafor");
  });

  it("shows bulk actions when users are selected", async () => {
    mockJsonFetch(fetchMock, apiUsers);

    await render(createElement(AdminConsole));
    await clickButton("Users");

    await waitFor(() => {
      expect(container.textContent).toContain("Mira Okafor");
    });

    const selectAll = container.querySelector<HTMLInputElement>(
      'input[aria-label="Select all users"]',
    );
    if (!selectAll) {
      throw new Error("Select-all checkbox not found");
    }
    await act(() => {
      selectAll.click();
      return Promise.resolve();
    });

    expect(container.textContent).toContain("selected");
    expect(container.textContent).toContain("Change role");
    expect(container.textContent).toContain("Suspend");
  });
});
