/* Desktop navigation collapse — the hamburger switches each surface's sidebar
   between its full width and a narrow icon rail. The choice is per device, so
   it lives in localStorage and is applied as `data-nav-collapsed` on `.app`. */

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "helix-nav-collapsed";
const listeners = new Set<() => void>();

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

let collapsed = typeof window === "undefined" ? false : readCollapsed();

export function setNavCollapsed(next: boolean): void {
  collapsed = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    /* Storage can be unavailable (private mode); the choice then lasts the session. */
  }
  listeners.forEach((listener) => listener());
}

export function toggleNavCollapsed(): void {
  setNavCollapsed(!collapsed);
}

export function useNavCollapsed(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => collapsed,
    () => false,
  );
}
