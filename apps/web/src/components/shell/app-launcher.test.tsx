// @vitest-environment jsdom

import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppLauncher } from "./app-launcher";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    preload: _preload,
    children,
    ...props
  }: {
    readonly to: string;
    readonly preload?: string;
    readonly children: ReactNode;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} data-preload={_preload} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/features/apps/use-enabled-apps", () => ({
  useEnabledApps: () => ({ isEnabled: () => true }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("AppLauncher", () => {
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

  it("uses preloaded links and supports grid keyboard navigation with focus restore", async () => {
    const close = vi.fn();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    act(() => {
      root.render(<AppLauncher open onClose={close} />);
    });
    await act(async () => Promise.resolve());

    const menu = container.querySelector<HTMLElement>('[role="menu"]');
    const items = Array.from(container.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]'));
    expect(items).toHaveLength(10);
    expect(items[0]?.dataset.preload).toBe("intent");
    expect(document.activeElement).toBe(items[0]);

    act(() => {
      items[0]?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(items[3]);

    act(() => {
      menu?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(close).toHaveBeenCalledTimes(1);

    act(() => root.render(<AppLauncher open={false} onClose={close} />));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
