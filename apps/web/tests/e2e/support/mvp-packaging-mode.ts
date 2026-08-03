/**
 * MVP packaging mode for Playwright (elite plan E1.3).
 *
 * Default e2e serves the full Vite graph (calendar/docs/meet/… available for
 * feature specs). Production MVP builds set `VITE_HELIX_MVP_ONLY=true`, which
 * filters the launcher via `workspaceAppsForBuild` and strips excluded routes.
 *
 * Run browser-level MVP packaging guarantees with:
 *
 *   VITE_HELIX_MVP_ONLY=true pnpm --filter @helix/web exec playwright test mvp-packaging
 *
 * `playwright.config.ts` forwards that env into the Vite webServer so the UI
 * under test matches the production MVP packaging boundary.
 */

/** True when the Playwright webServer is expected to serve an MVP-only build. */
export function isMvpPackagingE2e(): boolean {
  return process.env.VITE_HELIX_MVP_ONLY === "true";
}

/** Primary launcher apps advertised under production MVP packaging. */
export const MVP_PRIMARY_LAUNCHER_NAMES = ["Mail", "Drive", "Chat", "Helix AI", "Admin"] as const;

/** Full Workspace surfaces that must not appear as primary launcher apps in MVP. */
export const MVP_EXCLUDED_LAUNCHER_NAMES = [
  "Calendar",
  "Docs",
  "Sheets",
  "Slides",
  "Meet",
] as const;
