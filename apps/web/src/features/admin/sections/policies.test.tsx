// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSecurity } from "./policies";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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
    routerSearch.current = {};
    navigateMock.mockReset();
    navigateMock.mockImplementation(
      async (opts: { search?: (prev: Record<string, unknown>) => Record<string, unknown> }) => {
        if (typeof opts.search === "function") {
          routerSearch.current = opts.search({ ...routerSearch.current });
        }
        await act(async () => {
          root.render(
            createElement(
              QueryClientProvider,
              { client: queryClient },
              createElement(AdminSecurity),
            ),
          );
          await Promise.resolve();
        });
      },
    );
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

  it("edits enforcement through the shared control, not an inline style object", async () => {
    routerSearch.current = { policy: "mfa" };
    await render();

    await waitFor(() => {
      expect(
        container.querySelector<HTMLSelectElement>('select[aria-label^="Enforcement for"]'),
      ).not.toBeNull();
    });
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label^="Enforcement for"]',
    );
    // `INPUT_STYLE` could not carry a focus ring; `.admin-control` can, so the
    // control must actually be wearing the class rather than a style attribute.
    expect(select?.classList.contains("admin-control")).toBe(true);
    expect(select?.getAttribute("style")).toBeNull();
    expect(container.textContent).toContain("Enforcement");
  });

  it("saves solo-operator safeguards independently and preserves a failed draft", async () => {
    let saved = {
      ...policy("mfa", true, "required"),
      settings: {
        adminMfa: "tier_default",
        sensitiveActionMfaRequired: true,
        secondAdminApprovalRequired: true,
      },
      effectiveControls: {
        adminMfaRequired: true,
        sensitiveActionMfaRequired: true,
        secondAdminApprovalRequired: true,
        adminMfaSource: "tier",
      },
    };
    const writes: unknown[] = [];
    vi.mocked(fetch).mockImplementation((_url, init) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as typeof saved;
        writes.push(body);
        if (writes.length === 1)
          return Promise.resolve(
            Response.json(
              { error: { message: "Sign in again before changing administrator safeguards." } },
              { status: 403 },
            ),
          );
        saved = {
          ...saved,
          ...body,
          effectiveControls: {
            adminMfaRequired: false,
            sensitiveActionMfaRequired: false,
            secondAdminApprovalRequired: false,
            adminMfaSource: "policy",
          },
        };
        return Promise.resolve(Response.json({ policy: saved }));
      }
      return Promise.resolve(Response.json({ policies: [saved] }));
    });
    routerSearch.current = { policy: "mfa" };
    await render();
    await waitFor(() =>
      expect(container.querySelector('[aria-label="Administrator MFA"]')).not.toBeNull(),
    );
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Administrator MFA"]')!;
    await act(() => {
      select.value = "optional";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return Promise.resolve();
    });
    const checkbox = (label: string) =>
      [...container.querySelectorAll("label")]
        .find((item) => item.textContent?.trim() === label)
        ?.querySelector("input");
    await act(() => {
      checkbox("Require recent MFA for sensitive actions")?.click();
      checkbox("Require a second administrator for sensitive actions")?.click();
      return Promise.resolve();
    });
    const save = () =>
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Save policy",
      )!;
    await act(() => {
      save().click();
      return Promise.resolve();
    });
    await waitFor(() => expect(container.textContent).toContain("Sign in again before changing"));
    expect(select.value).toBe("optional");
    expect(checkbox("Require recent MFA for sensitive actions")?.checked).toBe(false);
    await act(() => {
      save().click();
      return Promise.resolve();
    });
    await waitFor(() =>
      expect(container.querySelector('[aria-label="Administrator MFA"]')).toBeNull(),
    );
    expect(writes).toEqual([
      {
        enabled: true,
        enforcement: "required",
        settings: {
          adminMfa: "optional",
          sensitiveActionMfaRequired: false,
          secondAdminApprovalRequired: false,
        },
      },
      {
        enabled: true,
        enforcement: "required",
        settings: {
          adminMfa: "optional",
          sensitiveActionMfaRequired: false,
          secondAdminApprovalRequired: false,
        },
      },
    ]);
    await waitFor(() =>
      expect(
        container.querySelector('dl[aria-label="Effective administrator safeguards"]')?.textContent,
      ).toContain("Optional (policy)"),
    );
    expect(container.textContent).toContain("Not required");
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
