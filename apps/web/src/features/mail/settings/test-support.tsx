/* Helpers for the mail settings component tests: a fresh query client per
   test, form input that React sees, and lookups by visible text. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { ShellOverlayContext, type ShellOverlayApi } from "@/components/shell/overlay-context";
import { mount, settle } from "@/test/ui";

export function renderSettings(ui: ReactNode, overlays: Partial<ShellOverlayApi> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const api: ShellOverlayApi = {
    openNotifications: () => undefined,
    openPalette: () => undefined,
    openSettings: () => undefined,
    ...overlays,
  };
  const view = mount(
    <QueryClientProvider client={client}>
      <ShellOverlayContext.Provider value={api}>{ui}</ShellOverlayContext.Provider>
    </QueryClientProvider>,
  );
  return { client, ...view };
}

/** Settles until `find` returns something (lazy chunks and queries resolve). */
export async function waitFor<T>(find: () => T | null | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const found = find();
    if (found !== null && found !== undefined) return found;
    await settle();
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export function buttonNamed(name: string, root: ParentNode = document): HTMLButtonElement | null {
  return (
    Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.getAttribute("aria-label") === name || button.textContent?.trim() === name,
    ) ?? null
  );
}

/** The control labelled `text`, by <label> or aria-label. */
export function control<T extends HTMLElement = HTMLInputElement>(
  text: string,
  root: ParentNode = document,
): T | null {
  const byAria = root.querySelector<T>(`[aria-label="${text}"]`);
  if (byAria) return byAria;
  const label = Array.from(root.querySelectorAll("label")).find(
    (node) => node.textContent?.trim() === text,
  );
  if (!label) return null;
  if (label.htmlFor !== "") return document.getElementById(label.htmlFor) as T | null;
  return label.querySelector<T>("input, select, textarea");
}

export function typeInto(element: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  if (!element) throw new Error("No field to type into");
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function choose(select: HTMLSelectElement | null, value: string) {
  if (!select) throw new Error("No select to choose from");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

export function dialogNamed(name: string): HTMLElement | null {
  return (
    Array.from(
      document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'),
    ).find((dialog) => {
      const title = document.getElementById(dialog.getAttribute("aria-labelledby") ?? "");
      return title?.textContent === name;
    }) ?? null
  );
}
