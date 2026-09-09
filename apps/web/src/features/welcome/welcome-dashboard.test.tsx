// @vitest-environment jsdom

import type { ReactNode } from "react";
import type { MouseEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WelcomeDashboard } from "./welcome-dashboard";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    onClick,
    ...props
  }: {
    readonly to: string;
    readonly children: ReactNode;
    readonly className?: string;
    readonly onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a
      href={to}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
      {...props}
    >
      {children}
    </a>
  ),
}));

vi.mock("@/components/shell", () => ({
  SurfaceFrame: ({ title, children }: { readonly title: string; readonly children: ReactNode }) => (
    <main data-title={title}>{children}</main>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

describe("WelcomeDashboard", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("shows the expected welcome actions", () => {
    const sendEvent = vi.fn().mockResolvedValue(undefined);
    act(() => {
      root.render(<WelcomeDashboard sendEvent={sendEvent} />);
    });

    expect(container.textContent).toContain("Welcome to Helix");
    expect(linkNamed("Configure your workspace")?.getAttribute("href")).toBe("/admin");
    expect(linkNamed("Connect with your team")?.getAttribute("href")).toBe("/chat");
    expect(linkNamed("Upload and share files")?.getAttribute("href")).toBe("/drive");
    expect(sendEvent).toHaveBeenCalledWith({ event: "viewed" });
  });

  it("records welcome action clicks without blocking navigation", () => {
    const sendEvent = vi.fn().mockResolvedValue(undefined);
    act(() => {
      root.render(<WelcomeDashboard sendEvent={sendEvent} />);
    });

    clickLink("Upload and share files");

    expect(sendEvent).toHaveBeenCalledWith({
      event: "action_clicked",
      action: "view_files",
    });
  });
});

function linkNamed(name: string): HTMLAnchorElement | undefined {
  return [...container.querySelectorAll<HTMLAnchorElement>("a")].find((link) =>
    link.textContent?.includes(name),
  );
}

function clickLink(name: string): void {
  const link = linkNamed(name);
  if (link === undefined) {
    throw new Error(`Missing link: ${name}`);
  }
  act(() => {
    link.click();
  });
}
