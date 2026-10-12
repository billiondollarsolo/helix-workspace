// @vitest-environment jsdom

import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellOverlaysForTest } from "@/test/shell-overlays";
import { ShellOverlayContext } from "./overlay-context";
import { BOTTOM_NAV_APP_SLOTS, BottomNav } from "./bottom-nav";

const location = vi.hoisted(() => ({ pathname: "/mail" }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    ...props
  }: {
    readonly to: string;
    readonly children: ReactNode;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useLocation: () => location,
}));

vi.mock("@/features/apps/use-enabled-apps", () => ({
  useEnabledApps: () => ({ isEnabled: () => true }),
}));

const overlays = shellOverlaysForTest();

describe("BottomNav", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    location.pathname = "/mail";
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function render() {
    act(() => {
      root.render(
        <ShellOverlayContext.Provider value={overlays}>
          <BottomNav />
        </ShellOverlayContext.Provider>,
      );
    });
  }

  function moreButton(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>("nav > button");
    if (button === null) throw new Error("Missing More button");
    return button;
  }

  it("shows at most five items: four apps and More", () => {
    render();
    const nav = container.querySelector('nav[aria-label="Apps"]');
    const links = Array.from(nav?.querySelectorAll("a") ?? []).map((link) => link.textContent);
    expect(links).toEqual(["Mail", "Calendar", "Drive", "Chat"]);
    expect(links).toHaveLength(BOTTOM_NAV_APP_SLOTS);
    expect(moreButton().textContent).toBe("More");
  });

  it("marks the active app with a pill rather than a tick", () => {
    render();
    const mail = container.querySelector<HTMLAnchorElement>('a[href="/mail"]');
    expect(mail?.getAttribute("aria-current")).toBe("page");
    expect(mail?.hasAttribute("data-active")).toBe(true);
    expect(mail?.querySelector(".bottom-nav-pill")).not.toBeNull();
    expect(moreButton().hasAttribute("data-active")).toBe(false);
  });

  it("opens a More sheet with the remaining apps, search, settings and About", () => {
    render();
    act(() => moreButton().click());
    const sheet = document.querySelector('[role="dialog"]');
    expect(sheet?.textContent).toContain("More");
    const tiles = Array.from(sheet?.querySelectorAll("a") ?? []).map((link) => link.textContent);
    expect(tiles).toEqual(["Meet", "Contacts", "Passwords", "Helix AI", "Admin", "Search"]);

    const about = Array.from(sheet?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "About Helix",
    );
    act(() => about?.click());
    expect(overlays.openAbout).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("highlights More while an overflow app is open", () => {
    location.pathname = "/admin/users";
    render();
    expect(moreButton().hasAttribute("data-active")).toBe(true);
  });
});
