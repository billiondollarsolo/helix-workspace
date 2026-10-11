// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "helix-nav-collapsed";

afterEach(() => {
  window.localStorage.clear();
  vi.resetModules();
});

async function loadStore() {
  return import("./nav-collapse");
}

describe("navigation collapse", () => {
  it("starts expanded and persists each toggle", async () => {
    const { toggleNavCollapsed, useNavCollapsed } = await loadStore();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    function Probe() {
      return <span>{useNavCollapsed() ? "collapsed" : "expanded"}</span>;
    }
    act(() => root.render(<Probe />));
    expect(container.textContent).toBe("expanded");

    act(() => toggleNavCollapsed());
    expect(container.textContent).toBe("collapsed");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("true");

    act(() => toggleNavCollapsed());
    expect(container.textContent).toBe("expanded");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("false");
    act(() => root.unmount());
    container.remove();
  });

  it("restores the saved state on the next visit", async () => {
    window.localStorage.setItem(STORAGE_KEY, "true");
    const { setNavCollapsed, useNavCollapsed } = await loadStore();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    function Probe() {
      return <span>{String(useNavCollapsed())}</span>;
    }
    act(() => root.render(<Probe />));
    expect(container.textContent).toBe("true");
    act(() => setNavCollapsed(false));
    expect(container.textContent).toBe("false");
    act(() => root.unmount());
    container.remove();
  });
});
