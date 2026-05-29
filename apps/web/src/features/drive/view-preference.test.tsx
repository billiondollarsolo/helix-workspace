// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DocumentSurfaceViewToggle,
  useDocumentSurfaceViewPreference,
  type DocumentSurfaceView,
} from "./view-preference";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("document surface view preference", () => {
  let container: HTMLDivElement;
  let root: Root;
  let stored: DocumentSurfaceView | null;
  let setItem: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stored = null;
    setItem = vi.fn((key: string, value: string) => {
      if (key === "helix.documentSurface.view" && (value === "grid" || value === "list")) {
        stored = value;
      }
    });
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => (key === "helix.documentSurface.view" ? stored : null)),
        setItem,
        removeItem: vi.fn(),
        clear: vi.fn(),
      },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("reads and writes the shared card/list view preference", () => {
    stored = "list";
    render();

    expect(container.querySelector("[data-view]")?.textContent).toBe("list");

    const cardButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.getAttribute("aria-label") === "Card view",
    );
    expect(cardButton).not.toBeNull();
    act(() => {
      cardButton?.click();
    });

    expect(container.querySelector("[data-view]")?.textContent).toBe("grid");
    expect(setItem).toHaveBeenCalledWith("helix.documentSurface.view", "grid");
    expect(stored).toBe("grid");
  });

  function render() {
    act(() => {
      root.render(<Harness />);
    });
  }
});

function Harness() {
  const [view, setView] = useDocumentSurfaceViewPreference();
  return (
    <div>
      <span data-view>{view}</span>
      <DocumentSurfaceViewToggle view={view} onViewChange={setView} />
    </div>
  );
}
