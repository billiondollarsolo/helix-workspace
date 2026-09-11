// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDefenderManagement } from "./agent-defender";
import { withAdminRouter } from "@/features/admin/console/test-router";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("AgentDefenderManagement", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("agent.defender.policy.list")) {
          return Promise.resolve(Response.json({ policies: [] }));
        }
        if (url.includes("agent.defender.holds.list")) {
          return Promise.resolve(Response.json({ holds: [] }));
        }
        return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
      }),
    );
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("explains allowlist vs open and the mail loop", async () => {
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          withAdminRouter(createElement(AgentDefenderManagement), "agent-defender"),
        ),
      );
    });
    await waitForText("Helix Agent Defender");
    expect(container.textContent).toContain("Allowlist only");
    expect(container.textContent).toContain("Start an Assistant turn");
  });
});

async function waitForText(text: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (document.body.textContent?.includes(text) === true) return;
    await act(async () => {
      await Promise.resolve();
    });
  }
  throw new Error(`Text not found: ${text}`);
}
