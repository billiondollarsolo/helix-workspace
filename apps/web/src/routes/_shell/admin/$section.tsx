import { createFileRoute, notFound } from "@tanstack/react-router";
import { AdminConsole } from "@/features/admin/admin-console";
import { isAdminSectionId, type AdminSectionId } from "@/features/admin/admin-console-data";

/* One route per admin section, so every surface is linkable, survives a
 * refresh, and works with back/forward.
 *
 * Parsing (rather than checking in `beforeLoad`) narrows the segment to
 * `AdminSectionId` once, at the router boundary — the component then receives
 * a typed section with no cast and no second guard. The section list is
 * closed, so an unknown segment is a 404 rather than a silent bounce to
 * Overview: a mistyped or stale admin link should say so. */
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
  component: AdminSectionRoute,
});

function AdminSectionRoute() {
  const { section } = Route.useParams();
  return <AdminConsole section={section} />;
}
