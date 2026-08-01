// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSecurity } from "./policies";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function policy(policyType: string, enabled: boolean, enforcement: string) {
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
                policy("mfa", true, "required"),
                policy("external_sharing", true, "optional"),
                policy("dlp", true, "required"),
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

  it("says outright that the policies are not enforced", async () => {
    /* None of the six is read by any runtime path: no login consults the MFA
       policy, no share consults the external-sharing allowlist, no message is
       scanned against the DLP settings. A page that presents them as controls
       without saying so invites an operator to configure a protection they do
       not have and then stop looking — which is worse than having no page. */
    await render();

    await waitFor(() => {
      expect(container.textContent).toContain("does not enforce them yet");
    });
    expect(container.textContent).toContain("recorded and audited");
    expect(container.textContent).toContain("does not change what the platform allows");
  });

  it("points somewhere the control can actually be applied", async () => {
    // Naming the gap without naming a remedy leaves the operator stuck.
    await render();

    await waitFor(() => {
      expect(container.textContent).toContain("identity provider");
    });
  });

  it("still shows a policy's own state, which stays meaningful as intent", async () => {
    /* The disclaimer is about enforcement, not about the record: what an
       operator saved is real, versioned and audited, and the page should keep
       showing it. */
    await render();

    await waitFor(() => {
      expect(container.textContent).toContain("Required");
    });
  });
});
