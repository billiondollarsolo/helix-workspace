/* The Helix app registry — the 10 workspace surfaces.
   Ported from the design handoff (shell.jsx → APPS). Drives the left Rail,
   the AppLauncher, and the command palette. Each surface has a route under
   the `_shell` layout. */

import type { IconName } from "@/components/icons";

export interface HelixApp {
  /** Stable id, also the route segment (`/mail`, `/calendar`, …). */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** Icon key from the Helix icon set. */
  readonly icon: IconName;
  /** Brand color used for the launcher tile. */
  readonly color: string;
  /** Route path under the `_shell` layout. */
  readonly route: string;
}

export const APPS: readonly HelixApp[] = [
  { id: "mail", name: "Mail", icon: "Mail", color: "#dc2626", route: "/mail" },
  { id: "calendar", name: "Calendar", icon: "Calendar", color: "#ea580c", route: "/calendar" },
  { id: "drive", name: "Drive", icon: "Drive", color: "#7c3aed", route: "/drive" },
  { id: "docs", name: "Docs", icon: "Doc", color: "#2563eb", route: "/docs" },
  { id: "sheets", name: "Sheets", icon: "Sheet", color: "#059669", route: "/sheets" },
  { id: "slides", name: "Slides", icon: "Image", color: "#f59e0b", route: "/slides" },
  { id: "meet", name: "Meet", icon: "Video", color: "#0891b2", route: "/meet" },
  { id: "chat", name: "Chat", icon: "Chat", color: "#db2777", route: "/chat" },
  { id: "assistant", name: "Helix AI", icon: "Sparkles", color: "#7c3aed", route: "/assistant" },
  { id: "admin", name: "Admin", icon: "Shield", color: "#475569", route: "/admin" },
];

/** Look up an app by its route path (exact or prefix match). */
export function appForRoute(pathname: string): HelixApp | undefined {
  return APPS.find(
    (app) => pathname === app.route || pathname.startsWith(`${app.route}/`),
  );
}
