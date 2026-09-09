// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentOperationalControls } from "./agent-controls-api";
import { withAdminRouter } from "@/features/admin/console/test-router";

const { getAgentOperationalControls, setAgentOperationalControls } = vi.hoisted(() => ({
  getAgentOperationalControls: vi.fn<() => Promise<AgentOperationalControls>>(),
  setAgentOperationalControls:
    vi.fn<
      (input: {
        readonly globalReadOnly?: boolean;
        readonly agentWritesEnabled?: boolean;
        readonly disableOrgId?: string;
        readonly enableOrgId?: string;
      }) => Promise<AgentOperationalControls>
    >(),
}));

vi.mock("./agent-controls-api", () => {
  const agentControlsQueryKeys = {
    root: ["admin", "agent-controls"] as const,
    detail: () => ["admin", "agent-controls", "detail"] as const,
  };
  return {
    agentControlsQueryKeys,
    agentControlsQueryOptions: () => ({
      queryKey: agentControlsQueryKeys.detail(),
      queryFn: () => getAgentOperationalControls(),
      retry: false,
      throwOnError: false,
      staleTime: 5_000,
    }),
    getAgentOperationalControls,
    setAgentOperationalControls,
  };
});

const { AgentControlsManagement } = await import("./agent-controls");

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function controlsOf(overrides: Partial<AgentOperationalControls> = {}): AgentOperationalControls {
  return {
    globalReadOnly: false,
    agentWritesEnabled: true,
    agentWritesDisabledOrgIds: [],
    disabledToolIds: [],
    ...overrides,
  };
}

describe("AgentControlsManagement", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let currentControls: AgentOperationalControls;

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
    currentControls = controlsOf();
    getAgentOperationalControls.mockReset();
    setAgentOperationalControls.mockReset();
    getAgentOperationalControls.mockImplementation(() => Promise.resolve({ ...currentControls }));
    setAgentOperationalControls.mockImplementation((input) => {
      currentControls = {
        ...currentControls,
        ...(input.globalReadOnly === undefined ? {} : { globalReadOnly: input.globalReadOnly }),
        ...(input.agentWritesEnabled === undefined
          ? {}
          : { agentWritesEnabled: input.agentWritesEnabled }),
        ...(input.disableOrgId === undefined
          ? {}
          : {
              agentWritesDisabledOrgIds: Array.from(
                new Set([...currentControls.agentWritesDisabledOrgIds, input.disableOrgId]),
              ),
            }),
        ...(input.enableOrgId === undefined
          ? {}
          : {
              agentWritesDisabledOrgIds: currentControls.agentWritesDisabledOrgIds.filter(
                (orgId) => orgId !== input.enableOrgId,
              ),
            }),
      };
      return Promise.resolve({ ...currentControls });
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
  });

  it("shows kill off and engages emergency kill via setAgentOperationalControls", async () => {
    await renderManagement();

    await waitFor(() => {
      expect(container.textContent).toContain("Emergency kill (global read-only)");
      expect(container.textContent).toContain("off");
      expect(buttonByText("Engage emergency kill")).not.toBeNull();
    });

    await clickButton("Engage emergency kill");

    await waitFor(() => {
      expect(setAgentOperationalControls).toHaveBeenCalledWith({ globalReadOnly: true });
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Emergency kill \(global read-only\)\s*ON/);
      expect(buttonByText("Clear emergency kill")).not.toBeNull();
    });
  });

  it("shows kill ON and clears emergency kill via setAgentOperationalControls(false)", async () => {
    currentControls = controlsOf({ globalReadOnly: true });

    await renderManagement();

    await waitFor(() => {
      expect(container.textContent).toMatch(/Emergency kill \(global read-only\)\s*ON/);
      expect(buttonByText("Clear emergency kill")).not.toBeNull();
    });

    await clickButton("Clear emergency kill");

    await waitFor(() => {
      expect(setAgentOperationalControls).toHaveBeenCalledWith({ globalReadOnly: false });
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Emergency kill \(global read-only\)\s*off/);
      expect(buttonByText("Engage emergency kill")).not.toBeNull();
    });
  });

  it("surfaces a load failure when admin.agents is missing", async () => {
    getAgentOperationalControls.mockRejectedValueOnce(new Error("forbidden"));

    await renderManagement();

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Could not load agent controls. You need admin.agents permission.",
      );
    });
  });

  async function renderManagement(): Promise<void> {
    await act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          withAdminRouter(createElement(AgentControlsManagement)),
        ),
      );
      return Promise.resolve();
    });
  }

  function buttonByText(label: string): HTMLButtonElement | null {
    return (
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === label,
      ) ?? null
    );
  }

  async function clickButton(label: string): Promise<void> {
    const button = buttonByText(label);
    if (button === null) {
      throw new Error(`Button not found: ${label}`);
    }
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
  }

  async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await act(async () => {
          await Promise.resolve();
        });
        await assertion();
        return;
      } catch (error) {
        lastError = error;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
    }
    throw lastError;
  }
});
