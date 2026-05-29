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
import {
  coreAppsShellQueryOptions,
  type CoreAppId,
} from "@/features/admin/core-apps-api";

export type AppId = string;

export interface EnabledApps {
  readonly isLoading: boolean;
  readonly isEnabled: (id: AppId) => boolean;
}

export function useEnabledApps(): EnabledApps {
  const query = useQuery(coreAppsShellQueryOptions());
  const apps = query.data?.apps ?? [];
  // Map of tracked core apps → enabled flag. Anything not in this map is
  // considered always-on so unrelated rail items (sheets/slides/admin) stay.
  const map = new Map<CoreAppId, boolean>(apps.map((a) => [a.id, a.enabled]));
  return {
    isLoading: query.isLoading,
    isEnabled: (id) => {
      const entry = map.get(id as CoreAppId);
      return entry === undefined ? true : entry;
    },
  };
}
