// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIObservabilityDashboard, prefetchAdminAIObservabilityQuery } from "./ai-observability";
import { adminPlatformConfigQueryOptions } from "./security-tier-readiness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("AIObservabilityDashboard", () => {
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
        mutations: { retry: false },
        queries: { retry: false },
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

  it("renders configured AI governance and PRD metric coverage", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        config: {
          security: { tier: "enterprise" },
          ai: {
            audit: { logRequests: "metadata-only", retainDays: 90 },
            costLimits: { perAgentPerDayUSD: 25, perOrgPerDayUSD: 500, perUserPerDayUSD: 5 },
            privacy: {
              classificationGating: true,
              blockExternalForClassifications: ["confidential", "restricted"],
            },
          },
        },
        readiness: { ready: true, requirements: [] },
      }),
    );

    await prefetchPlatformConfig();
    renderDashboard();

    expect(container.textContent).toContain("AI observability");
    expect(container.textContent).toContain("$5.00");
    expect(container.textContent).toContain("Cost by provider, feature, and actor");
    expect(container.textContent).toContain("provider, model, feature, actor_id");
    expect(container.textContent).toContain("helix_llm_errors_total");
    expect(container.textContent).toContain("90 day retention");
    expect(container.textContent).toContain("Blocks Confidential, Restricted");
    expect(tableByLabel("AI observability metrics").querySelectorAll('[role="row"]')).toHaveLength(
      7,
    );
    // h1 → h2 panels → h3 cards, with nothing skipped in between.
    expect(headingOutline()).toEqual([
      "H1:AI observability",
      "H2:Controls in force",
      "H3:Cost budgets",
      "H3:Request audit",
      "H3:Classification gating",
      "H3:Live telemetry",
      "H3:Routing fallback",
      "H2:Required AI metrics",
    ]);
  });

  it("reports unset AI governance fields instead of naming a mode nobody chose", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        config: { security: { tier: "personal" }, ai: {} },
        readiness: { ready: false, requirements: [] },
      }),
    );

    await prefetchPlatformConfig();
    renderDashboard();

    // No platform default exists for logRequests, so the card cannot claim one.
    expect(container.textContent).toContain("Not configured");
    // The personal tier does not gate classifications unless the org opts in.
    expect(container.textContent).toContain("Disabled");
  });

  it("surfaces backend-unavailable state without hiding provisioned dashboard coverage", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "missing admin scope" }, { status: 403 }));

    renderDashboard();
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = false;
    await waitForText("AI observability config is unavailable");
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    expect(container.textContent).toContain("AI observability config is unavailable");
    expect(container.textContent).toContain("Pending live telemetry");
    expect(container.textContent).toContain("Dashboard provisioned");
    expect(container.querySelector('[role="alert"]')?.getAttribute("data-kind")).toBe("error");
    // Without a tier there is no honest budget or gating state to show, so the
    // governance cards stay away rather than inventing one.
    expect(container.querySelector(".admin-ai-cost-card")).toBeNull();
    expect(headingOutline()).toEqual(["H1:AI observability", "H2:Required AI metrics"]);
  });

  it("prefetches the shared platform config query with contained failures", async () => {
    const ensureQueryData = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(prefetchAdminAIObservabilityQuery({ ensureQueryData })).resolves.toBeUndefined();
    expect(ensureQueryData).toHaveBeenCalledTimes(1);
  });

  function renderDashboard() {
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(AIObservabilityDashboard),
        ),
      );
    });
  }

  async function flushReact() {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function prefetchPlatformConfig() {
    await queryClient.prefetchQuery(adminPlatformConfigQueryOptions()).catch(() => undefined);
    await flushReact();
  }

  async function waitForText(text: string) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      await flushReact();
      if ((container.textContent ?? "").includes(text)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(container.textContent).toContain(text);
  }

  function headingOutline(): string[] {
    return Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6")).map(
      (heading) => `${heading.tagName}:${heading.textContent ?? ""}`,
    );
  }

  function tableByLabel(label: string) {
    const table = container.querySelector(`table[aria-label="${label}"]`);
    if (!(table instanceof HTMLTableElement)) {
      throw new Error(`Table not found: ${label}`);
    }
    return table;
  }
});
