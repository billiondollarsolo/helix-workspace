// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mvpOnly = vi.hoisted(() => ({ value: true }));

vi.mock("@/components/apps", () => ({
  get CORE_WORKSPACE_STORAGE_ONLY() {
    return mvpOnly.value;
  },
}));

import { SidePanel, SidePanelRail } from "./side-panel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("SidePanel MVP packaging", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    mvpOnly.value = true;
  });

  it("renders nothing when VITE_HELIX_MVP_ONLY / CORE_WORKSPACE_STORAGE_ONLY is active", async () => {
    mvpOnly.value = true;
    act(() => {
      root.render(
        <>
          <SidePanelRail activeTool="calendar" onToggle={() => undefined} />
          <SidePanel activeTool="calendar" onClose={() => undefined} />
        </>,
      );
    });
    await act(async () => Promise.resolve());

    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).toBe("");
  });

  it("renders the tool rail when MVP packaging is off", async () => {
    mvpOnly.value = false;
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
});
