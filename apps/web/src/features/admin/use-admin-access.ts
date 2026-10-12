/* Whether the signed-in person may open the Admin console. Drives the shell's
 * admin entry points (account menu, app launcher, command palette) and the
 * console's own "admin access required" state. Display only: the API enforces
 * every admin route itself. */

import { useQuery } from "@tanstack/react-query";
import { hasAdminConsoleAccess } from "@/features/admin/admin-console-data";
import { sessionUserQueryOptions } from "@/lib/auth";

export interface AdminAccess {
  readonly isLoading: boolean;
  readonly isAdmin: boolean;
}

export function useAdminAccess(): AdminAccess {
  const session = useQuery(sessionUserQueryOptions());
  return {
    isLoading: session.isLoading,
    isAdmin: hasAdminConsoleAccess(session.data?.scopes ?? []),
  };
}
