/* Per-app enablement for the shell rail + launcher.
 *
 * Source of truth is the platform's core-apps backend (`/api/core-apps`),
 * shared with the admin > Core apps panel that toggles them. The platform
 * tracks mail, chat, drive, calendar, meet, and assistant. On top of that:
 *   - Admin is offered only to people whose scopes open the Admin console.
 *   - Helix AI is offered only while a model provider answers
 *     (`assistant.status`), so nobody is led into a chat that cannot reply.
 *   - Passwords is offered only where the deployment installed the password
 *     manager and an admin turned it on (it rides on the same response).
 *
 * Used by:
 *   - components/shell/rail.tsx
 *   - components/shell/app-launcher.tsx
 *   - components/shell/bottom-nav.tsx
 *   - components/shell/command-palette.tsx
 */

import { useQuery } from "@tanstack/react-query";
import { coreAppsShellQueryOptions, type CoreAppId } from "@/features/admin/core-apps-api";
import { useAdminAccess } from "@/features/admin/use-admin-access";
import { useAssistantAvailability } from "@/features/assistant/use-assistant-availability";

type AppId = string;

export interface EnabledApps {
  readonly isLoading: boolean;
  readonly isEnabled: (id: AppId) => boolean;
}

export function useEnabledApps(): EnabledApps {
  const query = useQuery(coreAppsShellQueryOptions());
  const admin = useAdminAccess();
  const assistant = useAssistantAvailability();
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
    isLoading: query.isLoading || admin.isLoading || assistant.isLoading,
    isEnabled: (id) => {
      if (id === "admin") return admin.isAdmin;
      if (id === "passwords") {
        const passwords = query.data?.passwords;
        return (
          passwords?.installed === true &&
          passwords.enabled &&
          (passwords.native === true || passwords.url !== null)
        );
      }
      if (id === "contacts") return query.data !== undefined;
      const registered = map.get(id as CoreAppId) ?? false;
      return id === "assistant" ? registered && assistant.available : registered;
    },
  };
}
