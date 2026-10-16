// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AICostLimitsManagement, normalizeFormInput } from "./ai-cost-limits-management";
import { withAdminRouter } from "@/features/admin/console/test-router";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("normalizeFormInput", () => {
  it("asks for a person before anything is saved", () => {
    expect(
      normalizeFormInput({ actorId: "not-a-uuid", actorDailyUsd: "", featureDailyUsd: "" }),
    ).toBe("Choose the person this budget is for.");
  });

  it("treats blank budgets as tier defaults", () => {
    expect(
      normalizeFormInput({
        actorId: "00000000-0000-0000-0000-000000000001",
        actorDailyUsd: "",
        featureDailyUsd: "",
      }),
    ).toEqual({
      actorId: "00000000-0000-0000-0000-000000000001",
      actorDailyUsd: null,
      featureDailyUsd: null,
    });
  });

  it("parses numeric budgets and rejects negative values", () => {
    expect(
      normalizeFormInput({
        actorId: "00000000-0000-0000-0000-000000000001",
        actorDailyUsd: "25",
        featureDailyUsd: "5.5",
      }),
    ).toEqual({
      actorId: "00000000-0000-0000-0000-000000000001",
      actorDailyUsd: 25,
      featureDailyUsd: 5.5,
    });
    expect(
      normalizeFormInput({
        actorId: "00000000-0000-0000-0000-000000000001",
        actorDailyUsd: "-1",
        featureDailyUsd: "",
      }),
    ).toBe("Enter the daily budget as an amount of zero or more, or leave it empty.");
  });
});

describe("AICostLimitsManagement", () => {
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

  it("lists overrides by the person's name, never by an account id", async () => {
    const account = (id: string, displayName: string, email: string) => ({
      id,
      orgId: "00000000-0000-0000-0000-000000000001",
      type: "user",
      email,
      displayName,
      scopes: [],
      status: "active",
      disabledAt: null,
      lastSignInAt: null,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    });
    fetchMock.mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(
        Response.json(
          url.includes("/api/admin/users")
            ? {
                users: [
                  account(
                    "00000000-0000-0000-0000-0000000000aa",
                    "Jordan Rivera",
                    "jordan@example.test",
                  ),
                ],
                nextCursor: null,
              }
            : {
                tierDefault: { tier: "business", actorDailyUsd: 10, featureDailyUsd: null },
                limits: [
                  {
                    actorId: "00000000-0000-0000-0000-0000000000aa",
                    actorDailyUsd: 25,
                    featureDailyUsd: null,
                    updatedByActorId: "00000000-0000-0000-0000-0000000000bb",
                    updatedAt: "2026-05-21T00:00:00.000Z",
                  },
                  {
                    actorId: "00000000-0000-0000-0000-0000000000cc",
                    actorDailyUsd: 5,
                    featureDailyUsd: null,
                    updatedByActorId: "00000000-0000-0000-0000-0000000000bb",
                    updatedAt: "2026-05-21T00:00:00.000Z",
                  },
                ],
              },
        ),
      );
    });

    await act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          withAdminRouter(createElement(AICostLimitsManagement)),
        ),
      );
      return Promise.resolve();
    });

    await waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Jordan Rivera");
    });
    expect(document.body.textContent).toContain("jordan@example.test");
    // An override can outlive its account; it is still listed, and still clearable.
    expect(document.body.textContent).toContain("Removed account");
    expect(document.body.textContent).not.toMatch(/0000-0000-0000/u);
    act(() => buttonByText("Add limit").click());
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    // The override is for a person someone picks, not an id someone pastes.
    expect(document.querySelector('[role="combobox"]')).not.toBeNull();
    expect(document.querySelector('input[aria-label="Actor ID"]')).toBeNull();
    // h1 from PageHeading, then two sibling h2 panels — no skipped levels.
    expect(headingOutline()).toEqual([
      "H1:AI costs",
      "H2:Active overrides",
      "H2:Set a person's AI budget",
    ]);
    // A null tier budget is "no cap", not "tier default" — the tier row cannot
    // inherit from itself.
    expect(document.querySelector(".admin-page-subtitle")?.textContent).toContain(
      "business tier default: $10.00 per person, Unlimited per feature.",
    );
    expect(document.body.textContent).toContain("$25.00");
    // Save owns the only filled button; the row action stays outlined.
    expect(buttonByLabel("Clear AI cost limit for Jordan Rivera").dataset.variant).toBe("outline");
    expect(buttonByText("Save limit").dataset.variant).toBe("default");
    const requestUrls = fetchMock.mock.calls.map(([requestInput]) =>
      typeof requestInput === "string"
        ? requestInput
        : requestInput instanceof URL
          ? requestInput.toString()
          : requestInput.url,
    );
    expect(requestUrls.some((url) => url.includes("/api/admin/ai/cost-limits"))).toBe(true);
  });

  it("explains an empty override list with a whole-panel empty state", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        tierDefault: { tier: "business", actorDailyUsd: 10, featureDailyUsd: null },
        limits: [],
      }),
    );

    await act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          withAdminRouter(createElement(AICostLimitsManagement)),
        ),
      );
      return Promise.resolve();
    });

    await waitFor(() => {
      expect(document.body.textContent ?? "").toContain("No per-user overrides");
    });
    expect(document.querySelector('[data-slot="empty-state"]')).not.toBeNull();
    expect(document.body.textContent).toContain("business tier default");
    // An all-header table says nothing; the empty state replaces it entirely.
    expect(document.querySelector('[role="table"]')).toBeNull();
  });

  it("surfaces an unavailable admin API as an error banner", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "denied" }, { status: 403 }));

    await act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          withAdminRouter(createElement(AICostLimitsManagement)),
        ),
      );
      return Promise.resolve();
    });

    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Cost limits could not be loaded. You may not have permission to manage AI costs.",
      );
    });
    expect(document.querySelector('[role="alert"]')?.getAttribute("data-slot")).toBe(
      "inline-error",
    );
    // No override list loaded, so nothing may claim the list is empty.
    expect(document.querySelector('[data-slot="empty-state"]')).toBeNull();
  });

  function headingOutline(): string[] {
    return Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")).map(
      (heading) => `${heading.tagName}:${heading.textContent ?? ""}`,
    );
  }

  function buttonByText(name: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes(name),
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Button not found: ${name}`);
    }
    return button;
  }

  function buttonByLabel(label: string): HTMLButtonElement {
    const button = document.querySelector(`button[aria-label="${label}"]`);
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Button not found: ${label}`);
    }
    return button;
  }
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
