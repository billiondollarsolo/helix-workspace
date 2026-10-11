/* Shared helpers for components/ui tests: mount into a fresh root, send
   keys to the focused element, and run axe against the rendered DOM. */

import axe from "axe-core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

export interface Mounted {
  container: HTMLDivElement;
  rerender: (ui: ReactNode) => void;
  unmount: () => void;
}

const mounted = new Set<{ root: Root; container: HTMLDivElement }>();

export function mount(ui: ReactNode): Mounted {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const entry = { root, container };
  mounted.add(entry);
  act(() => root.render(ui));
  return {
    container,
    rerender: (next) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
      mounted.delete(entry);
    },
  };
}

/** Unmount everything `mount` created; call from afterEach. */
export function unmountAll(): void {
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted.clear();
  document.body.innerHTML = "";
}

/** Let effects, microtasks, and Radix's deferred focus settle. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Dispatch a keydown at `target` (default: the focused element). */
export function press(
  key: string,
  init: KeyboardEventInit = {},
  target: Element | null = document.activeElement,
): void {
  if (!target) throw new Error(`No target for key ${key}`);
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

/** `press`, then let deferred focus moves (Radix uses timers) settle. */
export async function key(
  name: string,
  init: KeyboardEventInit = {},
  target: Element | null = document.activeElement,
): Promise<void> {
  press(name, init, target);
  await settle();
}

export function click(target: Element | null, init: MouseEventInit = {}): void {
  if (!target) throw new Error("No click target");
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
}

/** axe violations in `node`; layout-dependent rules cannot run in jsdom. */
export async function axeViolations(node: Element = document.body): Promise<string[]> {
  const result = await axe.run(node, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  return result.violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );
}

export function byRole(role: string, name?: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[role="${role}"]`)).filter(
    (node) =>
      name === undefined ||
      node.getAttribute("aria-label") === name ||
      node.textContent?.trim() === name,
  );
}
