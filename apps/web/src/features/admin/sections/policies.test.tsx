// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSecurity } from "./policies";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function policy(
  policyType: string,
  enabled: boolean,
  enforcement: string,
  runtime?: {
    mode: "enforced" | "partial" | "recorded_only";
    displayLevel: "off" | "recorded" | "active" | "required";
    displayLevelOn: boolean;
  },
) {
  return {
    id: `p-${policyType}`,
    orgId: "org-1",
    policyType,
    enabled,
    enforcement,
    settings: {},
    updatedBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(runtime === undefined
      ? {}
      : {
          runtimeStatus: {
            mode: runtime.mode,
            summary: "test",
            enforcementPoints: [],
            displayLevel: runtime.displayLevel,
            displayLevelOn: runtime.displayLevelOn,
          },
        }),
  };
}

describe("AdminSecurity", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  function wrap(node: ReactNode): ReactNode {
    return createElement(QueryClientProvider, { client: queryClient }, node);
  }

  async function waitFor(assertion: () => void): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        assertion();
        return;
      } catch {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        });
      }
    }
    assertion();
  }

  async function render(): Promise<void> {
    await act(async () => {
      root.render(wrap(createElement(AdminSecurity)));
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: vi.fn(() => null), removeItem: vi.fn(), setItem: vi.fn() },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              policies: [
                policy("mfa", true, "required", {
                  mode: "partial",
                  displayLevel: "active",
                  displayLevelOn: true,
                }),
                policy("external_sharing", true, "required", {
                  mode: "enforced",
                  displayLevel: "required",
                  displayLevelOn: true,
                }),
                policy("dlp", true, "optional", {
                  mode: "recorded_only",
                  displayLevel: "recorded",
                  displayLevelOn: false,
                }),
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
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

  it("explains runtime status instead of claiming blanket non-enforcement", async () => {
    await render();

    await waitFor(() => {
      expect(container.textContent).toContain("runtime status");
    });
    expect(container.textContent).toContain("External sharing");
    expect(container.textContent).toContain("identity provider");
  });

  it("renders honest chips from runtimeStatus (Required only when enforced)", async () => {
    await render();

    await waitFor(() => {
      expect(container.textContent).toContain("Required");
      expect(container.textContent).toContain("Recorded");
      expect(container.textContent).toContain("Partial");
    });
  });
});
