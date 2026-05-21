// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AICostLimitsManagement,
  normalizeFormInput,
} from "./ai-cost-limits-management";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("normalizeFormInput", () => {
  it("rejects an invalid actor id", () => {
    expect(normalizeFormInput({ actorId: "not-a-uuid", actorDailyUsd: "", featureDailyUsd: "" })).toBe(
      "Actor ID must be a valid UUID.",
    );
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
          createElement(AICostLimitsManagement),
        ),
      );
      return Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent ?? "").toContain("00000000-0000-0000-0000-0000000000aa");
    });
    expect(container.textContent).toContain("Per-user AI cost limits");
    expect(container.textContent).toContain("$25.00");
    const requestInput = fetchMock.mock.calls[0]?.[0];
    const requestUrl =
      typeof requestInput === "string"
        ? requestInput
        : requestInput instanceof URL
          ? requestInput.toString()
          : (requestInput?.url ?? "");
    expect(requestUrl).toContain("/api/admin/ai/cost-limits");
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
