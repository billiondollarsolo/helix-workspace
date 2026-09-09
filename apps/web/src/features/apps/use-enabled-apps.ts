/* Per-app enablement for the shell rail + launcher.
 *
 * Source of truth is the platform's core-apps backend (`/api/core-apps`),
 * shared with the admin > Core apps panel that toggles them. The platform
 * tracks a subset (mail, chat, drive, docs, calendar, meet, assistant,
 * editors); rail items outside that set (sheets, slides, admin) are always
 * visible.
 *
 * Used by:
 *   - components/shell/rail.tsx
 *   - components/shell/app-launcher.tsx
 */

import { useQuery } from "@tanstack/react-query";
import { coreAppsShellQueryOptions, type CoreAppId } from "@/features/admin/core-apps-api";

export type AppId = string;

export interface EnabledApps {
  readonly isLoading: boolean;
  readonly isEnabled: (id: AppId) => boolean;
}

export function useEnabledApps(): EnabledApps {
  const query = useQuery(coreAppsShellQueryOptions());
  const apps = query.data?.apps ?? [];
  /* `registered`, not `enabled`. The two differ: `enabled` is the org-wide
     admin toggle, while `registered` is `enabled && inRole` — whether the API
     process this client talks to actually serves the app. A role-based boot
     (`HELIX_APPS` / `HELIX_ROLE`) leaves an app enabled but unregistered, and
     keying off `enabled` there put a launcher tile in front of routes and tools
     that answer 404. Under MVP packaging the build-time filter in
     `workspaceAppsForBuild` hides them anyway, which is why this never
     surfaced; it bites any deployment that splits apps across roles. */
  const map = new Map<CoreAppId, boolean>(apps.map((a) => [a.id, a.registered]));
  return {
    isLoading: query.isLoading,
    isEnabled: (id) => {
      return map.get(id as CoreAppId) ?? true;
    },
  };
}
