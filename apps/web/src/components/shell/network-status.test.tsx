// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkStatus } from "./network-status";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("NetworkStatus", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalOnLine: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    originalOnLine = Object.getOwnPropertyDescriptor(navigator, "onLine");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalOnLine === undefined) {
      Reflect.deleteProperty(navigator, "onLine");
    } else {
      Object.defineProperty(navigator, "onLine", originalOnLine);
    }
    vi.useRealTimers();
  });

  it("announces offline and reconnected states without leaving a permanent banner", () => {
    setOnline(false);
    act(() => root.render(<NetworkStatus />));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("You’re offline");

    setOnline(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Back online");

    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: online,
  });
}
