import type { RefObject } from "react";
import { useShortcuts } from "@/lib/shortcuts/use-shortcuts";

/** ⌘/Ctrl+Enter sends and ⌘/Ctrl+Shift+C/B add Cc/Bcc, only while focus is in
    this composer (several can be open) and not in a dialog stacked on it. */
export function useComposeShortcuts(
  rootRef: RefObject<HTMLElement | null>,
  actions: { readonly send: () => void; readonly cc: () => void; readonly bcc: () => void },
) {
  const within = (event: KeyboardEvent) => {
    const target = event.target instanceof Node ? event.target : null;
    return target !== null && rootRef.current?.contains(target) === true;
  };
  const bind = (action: () => void) => (event: KeyboardEvent) => {
    if (!within(event)) return false;
    action();
  };
  useShortcuts("dialog", {
    "dialog.send": bind(actions.send),
    "dialog.cc": bind(actions.cc),
    "dialog.bcc": bind(actions.bcc),
  });
}
