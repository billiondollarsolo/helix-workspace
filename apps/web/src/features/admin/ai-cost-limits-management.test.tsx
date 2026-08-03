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
  it("rejects an invalid actor id", () => {
    expect(
      normalizeFormInput({ actorId: "not-a-uuid", actorDailyUsd: "", featureDailyUsd: "" }),
    ).toBe("Actor ID must be a valid UUID.");
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
    ).toBe("Actor daily budget must be a non-negative number.");
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

  it("renders the per-user AI cost limits table from the admin API", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          tierDefault: { tier: "business", actorDailyUsd: 10, featureDailyUsd: null },
          limits: [
            {
              actorId: "00000000-0000-0000-0000-0000000000aa",
              actorDailyUsd: 25,
              featureDailyUsd: null,
              updatedByActorId: "00000000-0000-0000-0000-0000000000bb",
              updatedAt: "2026-05-21T00:00:00.000Z",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
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
      expect(container.textContent ?? "").toContain("00000000-0000-0000-0000-0000000000aa");
    });
    // h1 from PageHeading, then two sibling h2 panels — no skipped levels.
    expect(headingOutline()).toEqual([
      "H1:Cost limits",
      "H2:Set a per-user override",
      "H2:Active overrides",
    ]);
    // A null tier budget is "no cap", not "tier default" — the tier row cannot
    // inherit from itself.
    expect(container.querySelector(".admin-page-subtitle")?.textContent).toContain(
      "business tier default (actor $10.00, feature no cap)",
    );
    expect(container.textContent).toContain("$25.00");
    // Save owns the only filled button; the row action stays outlined.
    expect(
      buttonByLabel("Clear AI cost limit for 00000000-0000-0000-0000-0000000000aa").dataset.variant,
    ).toBe("outline");
    expect(buttonByText("Save limit").dataset.variant).toBe("default");
    const requestInput = fetchMock.mock.calls[0]?.[0];
    const requestUrl =
      typeof requestInput === "string"
        ? requestInput
        : requestInput instanceof URL
          ? requestInput.toString()
          : (requestInput?.url ?? "");
    expect(requestUrl).toContain("/api/admin/ai/cost-limits");
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
      expect(container.textContent ?? "").toContain("No per-user overrides");
    });
    expect(container.querySelector(".admin-empty")).not.toBeNull();
    expect(container.textContent).toContain("business tier default");
    // An all-header table says nothing; the empty state replaces it entirely.
    expect(container.querySelector('[role="table"]')).toBeNull();
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
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Cost limits are unavailable or admin AI scope is missing.",
      );
    });
    expect(container.querySelector('[role="alert"]')?.getAttribute("data-kind")).toBe("error");
    // No override list loaded, so nothing may claim the list is empty.
    expect(container.querySelector(".admin-empty")).toBeNull();
  });

  function headingOutline(): string[] {
    return Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6")).map(
      (heading) => `${heading.tagName}:${heading.textContent ?? ""}`,
    );
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

  function buttonByLabel(label: string): HTMLButtonElement {
    const button = container.querySelector(`button[aria-label="${label}"]`);
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
