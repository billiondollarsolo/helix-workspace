// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouteErrorState, RouteNotFoundState, routeErrorDetails } from "./__root";

vi.mock("@tanstack/react-router", () => ({
  createRootRouteWithContext: () => (config: unknown) => config,
  Link: ({
    to,
    children,
    ...props
  }: {
    readonly to: string;
    readonly children: ReactNode;
    readonly className?: string;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  Outlet: () => null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("root route recovery states", () => {
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
  });

  it("hides internal errors in production mode", () => {
    expect(routeErrorDetails(new Error("database password leaked"), false)).toBeNull();
    expect(routeErrorDetails(new Error("debug detail"), true)).toContain("debug detail");
  });

  it("offers retry and home recovery actions and focuses the state", () => {
    const reset = vi.fn();
    act(() => {
      root.render(<RouteErrorState error={new Error("boom")} reset={reset} />);
    });

    const main = container.querySelector("main");
    const retry = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Retry",
    );
    expect(document.activeElement).toBe(main);
    expect(container.textContent).toContain("Your work is still safe.");
    expect(container.querySelector<HTMLAnchorElement>('a[href="/"]')).not.toBeNull();
    act(() => retry?.click());
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("renders an actionable not-found state", () => {
    act(() => {
      root.render(<RouteNotFoundState />);
    });
    expect(container.textContent).toContain("That page isn’t here");
    expect(container.querySelector<HTMLAnchorElement>('a[href="/"]')?.textContent).toBe(
      "Return home",
    );
  });
});
