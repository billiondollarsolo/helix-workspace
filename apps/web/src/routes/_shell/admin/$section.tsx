import { createFileRoute, notFound } from "@tanstack/react-router";
import { AdminAccessRequired } from "@/features/admin/admin-access-required";
import { AdminConsole } from "@/features/admin/admin-console";
import { prefetchAdminSectionData } from "@/features/admin/console/section-loaders";
import {
  hasAdminConsoleAccess,
  isAdminSectionId,
  type AdminSectionId,
} from "@/features/admin/admin-console-data";
import { useAdminAccess } from "@/features/admin/use-admin-access";
import { sessionUserQueryOptions, type SessionUser } from "@/lib/auth";
import {
  validateAdminSectionSearch,
  type AdminSectionSearch,
} from "@/features/admin/admin-section-search";

/* One route per admin section, so every surface is linkable, survives a
 * refresh, and works with back/forward.
 *
 * Parsing (rather than checking in `beforeLoad`) narrows the segment to
 * `AdminSectionId` once, at the router boundary — the component then receives
 * a typed section with no cast and no second guard. The section list is
 * closed, so an unknown segment is a 404 rather than a silent bounce to
 * Overview: a mistyped or stale admin link should say so.
 *
 * Search params (`?tab=`, `?tier=`, filters, …) are section-owned deep-link
 * state. See `admin-section-search.ts`. */

export type { AdminSectionSearch };

export const Route = createFileRoute("/_shell/admin/$section")({
  params: {
    parse: (raw: Record<string, string>): { section: AdminSectionId } => {
      const value = raw.section ?? "";
      if (!isAdminSectionId(value)) {
        // TanStack Router signals a missing route by throwing.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw notFound();
      }
      return { section: value };
    },
    stringify: (params: { section: AdminSectionId }) => ({ section: params.section }),
  },
  validateSearch: (search: Record<string, unknown>): AdminSectionSearch =>
    validateAdminSectionSearch(search),
  /* Starts the section's chunk *and* its first request(s) at navigation time
   * instead of after the component mounts. The two used to be strictly
   * serialized — chunk fetch, parse, mount, then the first `useQuery` — which
   * roughly doubled time-to-content and meant nine already-written
   * `prefetchAdmin*Query` helpers were dead code.
   *
   * Deliberately not awaited: TanStack shows a pending state only after
   * `defaultPendingMs` (1s), so awaiting a slow prefetch would hold the old
   * page on screen rather than paint the new one's skeleton. Kicking it off and
   * returning lets the component mount immediately and its own `useQuery` join
   * the in-flight promise.
   *
   * This also runs under `preloadRoute`, so hovering a sidebar link now warms
   * the data as well as the code. */
  loader: ({ context, params }) => {
    // The shell has already loaded the session; skip requests the API would refuse.
    const session = context.queryClient.getQueryData<SessionUser | null>(
      sessionUserQueryOptions().queryKey,
    );
    if (session !== undefined && session !== null && !hasAdminConsoleAccess(session.scopes ?? []))
      return;
    void prefetchAdminSectionData(context.queryClient, params.section);
  },
  component: AdminSectionRoute,
});

function AdminSectionRoute() {
  const { section } = Route.useParams();
  const access = useAdminAccess();
  if (!access.isLoading && !access.isAdmin) return <AdminAccessRequired />;
  return <AdminConsole section={section} />;
}
