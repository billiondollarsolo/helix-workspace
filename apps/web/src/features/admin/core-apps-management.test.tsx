// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreAppsManagement } from "./core-apps-management";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const adminStatus = {
  role: "all",
  apps: [
    {
      id: "mail",
      name: "Mail",
      description: "SMTP send/receive.",
      enabled: true,
      inRole: true,
      registered: true,
    },
    {
      id: "chat",
      name: "Chat",
      description: "Realtime channels.",
      enabled: false,
      inRole: true,
      registered: false,
    },
  ],
};

describe("CoreAppsManagement", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

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
  });

  it("renders core apps with enabled/disabled status from the admin API", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(adminStatus), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(CoreAppsManagement),
        ),
      );
      return Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent ?? "").toContain("Mail");
    });
    expect(container.textContent).toContain("Core apps");
    expect(container.textContent).toContain("Enabled");
    expect(container.textContent).toContain("Disabled");
    const requestUrl = requestUrlOf(fetchMock.mock.calls[0]?.[0]);
    expect(requestUrl).toContain("/api/admin/core-apps");
  });

  it("toggles a core app off via the admin API", async () => {
    fetchMock.mockImplementation((input) => {
      const url = requestUrlOf(input);
      if (url.includes("/api/admin/core-apps/mail")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              role: "all",
              apps: adminStatus.apps,
              changed: { appId: "mail", from: true, to: false, requiresRestart: true },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(adminStatus), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    await act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(CoreAppsManagement),
        ),
      );
      return Promise.resolve();
    });

    await waitFor(() => {
      expect(container.querySelector('[aria-label="Disable Mail"]')).not.toBeNull();
    });
    const disableButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Disable Mail"]',
    );
    await act(async () => {
      disableButton?.click();
      await Promise.resolve();
    });

    await waitFor(() => {
      const toggleCall = fetchMock.mock.calls.find((call) =>
        requestUrlOf(call[0]).includes("/api/admin/core-apps/mail"),
      );
      expect(toggleCall).toBeDefined();
      expect(toggleCall?.[1]?.method).toBe("PATCH");
    });
  });

  it("shows an unavailable notice when the admin API denies access", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Missing required scope" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );

    await act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(CoreAppsManagement),
        ),
      );
      return Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent ?? "").toContain("unavailable");
    });
  });
});

function requestUrlOf(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (input instanceof Request) {
    return input.url;
  }
  return "";
}

async function waitFor(assertion: () => void) {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < 2_000) {
    try {
      assertion();
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
