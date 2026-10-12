// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SidePanel, SidePanelRail } from "./side-panel";

const assistant = vi.hoisted(() => ({ available: true }));

vi.mock("@/features/assistant/use-assistant-availability", () => ({
  useAssistantAvailability: () => ({
    isLoading: false,
    available: assistant.available,
    message: null,
  }),
}));
vi.mock("@/features/assistant/assistant-side-panel", () => ({
  AssistantSidePanel: () => <p>Assistant panel</p>,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("SidePanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    assistant.available = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the tool rail ", async () => {
    act(() => {
      root.render(<SidePanelRail activeTool={null} onToggle={() => undefined} />);
    });
    await act(async () => Promise.resolve());

    const labels = Array.from(container.querySelectorAll("button")).map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels).toContain("Calendar");
    expect(labels).toContain("Helix AI");
  });

  it("hides Helix AI while no model provider answers", async () => {
    assistant.available = false;
    act(() => {
      root.render(
        <>
          <SidePanelRail activeTool="ai" onToggle={() => undefined} />
          <SidePanel activeTool="ai" onClose={() => undefined} />
        </>,
      );
    });
    await act(async () => Promise.resolve());

    const labels = Array.from(container.querySelectorAll("button")).map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels).toContain("Calendar");
    expect(labels).not.toContain("Helix AI");
    expect(container.textContent).not.toContain("Assistant panel");
  });
});
