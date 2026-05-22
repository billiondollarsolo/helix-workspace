// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellOverlayContext } from "@/components/shell";
import { AdminConsole } from "./admin-console";

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

/** Set a React-controlled input's value via the native prototype setter so
 *  the synthetic `input` event reflects the new value. */
function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set?.call(input, value);
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
          createElement(
            ShellOverlayContext.Provider,
            { value: overlayApi },
            node,
          ),
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

  it("renders the Overview section with stat cards by default", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(apiUsers), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await render(createElement(AdminConsole));

    expect(container.textContent).toContain("Workspace overview");
    expect(container.textContent).toContain("Active users");
    expect(container.textContent).toContain("Sign-in activity (7 days)");
    expect(container.textContent).toContain("Security recommendations");
  });

  it("navigates to each admin section from the sidebar", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(apiUsers), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await render(createElement(AdminConsole));

    await clickButton("Groups & OUs");
    expect(container.textContent).toContain("Organizational Units");

    await clickButton("Security");
    expect(container.textContent).toContain("Security policies");
    await waitFor(() => {
      expect(container.textContent).toContain("Multi-factor authentication");
    });

    await clickButton("Apps");
    await waitFor(() => {
      expect(container.textContent).toContain("App permissions");
    });

    await clickButton("Billing");
    await waitFor(() => {
      expect(container.textContent).toContain("Business Plus");
    });

    await clickButton("Audit log");
    expect(container.textContent).toContain("policy.update");

    await clickButton("Domain");
    await waitFor(() => {
      expect(container.textContent).toContain("DKIM");
    });
  });

  it("wires the Users table to the admin users API", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(apiUsers), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

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

  it("falls back to seeded directory when the users API returns no rows", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ users: [], nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await render(createElement(AdminConsole));
    await clickButton("Users");

    await waitFor(() => {
      expect(container.textContent).toContain("Priya Anand");
    });
  });

  it("filters users by search query", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ users: [], nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await render(createElement(AdminConsole));
    await clickButton("Users");

    await waitFor(() => {
      expect(container.textContent).toContain("Priya Anand");
    });

    const search = container.querySelector<HTMLInputElement>(
      'input[aria-label="Filter users"]',
    );
    if (!search) {
      throw new Error("Search input not found");
    }
    await act(() => {
      setInputValue(search, "marcus");
      return Promise.resolve();
    });

    expect(container.textContent).toContain("Marcus Bell");
    expect(container.textContent).not.toContain("Priya Anand");
  });

  it("shows bulk actions when users are selected", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ users: [], nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await render(createElement(AdminConsole));
    await clickButton("Users");

    await waitFor(() => {
      expect(container.textContent).toContain("Priya Anand");
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
