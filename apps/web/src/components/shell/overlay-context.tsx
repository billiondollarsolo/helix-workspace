/* Shell overlay state — notifications panel, command palette, settings page.
   Ported from app.jsx's root-owned overlay booleans. Provided once by the
   `_shell` layout so any surface or shell control can open them. */

import { createContext, useContext } from "react";

export interface ShellOverlayApi {
  /** Open the notifications panel. */
  openNotifications: () => void;
  /** Open the ⌘K command palette. */
  openPalette: () => void;
  /** Open the full-screen settings page. */
  openSettings: () => void;
}

export const ShellOverlayContext = createContext<ShellOverlayApi | null>(null);

/**
 * Access the shell overlay triggers. Must be used within the `_shell` layout.
 */
export function useShellOverlays(): ShellOverlayApi {
  const context = useContext(ShellOverlayContext);
  if (!context) {
    throw new Error("useShellOverlays must be used within the _shell layout");
  }
  return context;
}
