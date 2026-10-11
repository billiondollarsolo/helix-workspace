// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNavCollapsed } from "./nav-collapse";
import { shellOverlaysForTest } from "@/test/shell-overlays";
import { ShellOverlayContext } from "./overlay-context";
import { SurfaceFrame } from "./surface-frame";

const navigate = vi.fn();
const media = vi.hoisted(() => ({ mobile: false }));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: { count: 3 } }),
}));

vi.mock("./use-mobile-layout", () => ({
  useMobileLayout: () => media.mobile,
}));

vi.mock("./profile-menu", () => ({ ProfileMenu: () => null }));
vi.mock("./side-panel", () => ({
  SidePanel: () => null,
  SidePanelRail: () => null,
}));

const overlays = shellOverlaysForTest();

describe("SurfaceFrame", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.history.replaceState(null, "", "/calendar");
    setNavCollapsed(false);
    window.localStorage.clear();
    media.mobile = false;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function render(children: ReactNode = <aside className="surf-sidebar" />) {
    act(() => {
      root.render(
        <ShellOverlayContext.Provider value={overlays}>
          <SurfaceFrame title="Calendar" searchPlaceholder="Search events">
            {children}
          </SurfaceFrame>
        </ShellOverlayContext.Provider>,
      );
    });
  }

  function button(name: string): HTMLButtonElement {
    const match = container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
    if (match === null) throw new Error(`Missing ${name}`);
    return match;
  }

  it("collapses the desktop sidebar and remembers it", () => {
    render();
    const toggle = button("Main menu");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(window.localStorage.getItem("helix-nav-collapsed")).toBe("true");
  });

  it("opens the sidebar as a drawer on phones without touching the desktop choice", () => {
    media.mobile = true;
    render();
    const toggle = button("Main menu");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".workspace")?.getAttribute("data-navigation-open")).toBe(
      "true",
    );
    expect(window.localStorage.getItem("helix-nav-collapsed")).toBeNull();
  });

  it("submits the top search to /search, scoped to the current app", () => {
    render();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search events"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, "harbor review");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(navigate).toHaveBeenCalledWith({
      to: "/search",
      search: { q: "harbor review", type: "calendar" },
    });
  });

  it("opens quick settings from the cog and shows the unread count", () => {
    render();
    act(() => button("Quick settings").click());
    expect(overlays.openQuickSettings).toHaveBeenCalledTimes(1);
    expect(button("Notifications, 3 unread")).toBeTruthy();
  });
});
