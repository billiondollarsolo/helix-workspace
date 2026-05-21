// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreAppGate } from "./core-app-gate";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("CoreAppGate", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    fetchMock = vi.fn<typeof fetch>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: vi.fn(() => null), removeItem: vi.fn(), setItem: vi.fn() },
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

  async function renderGate(app: "mail" | "chat") {
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () =>
        createElement(CoreAppGate, {
          app,
          children: createElement("p", null, "App content visible"),
        }),
    });
    const adminRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin",
      component: () => createElement("p", null, "admin"),
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, adminRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(RouterProvider, { router } as never),
        ),
      );
      await Promise.resolve();
    });
  }

  it("renders app content when the core app is registered", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          role: "all",
          apps: [{ id: "mail", name: "Mail", enabled: true, registered: true }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await renderGate("mail");
    await waitFor(() => {
      expect(container.textContent ?? "").toContain("App content visible");
    });
  });

  it("renders the disabled state when the core app is not registered", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          role: "all",
          apps: [{ id: "chat", name: "Chat", enabled: false, registered: false }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await renderGate("chat");
    await waitFor(() => {
      expect(container.textContent ?? "").toContain("Chat is disabled");
    });
    expect(container.textContent).not.toContain("App content visible");
  });
});

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
