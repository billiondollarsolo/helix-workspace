/* Helix Admin console — the surface shell.
 *
 * This file owns three things and nothing else: the chrome, the sidebar, and
 * turning the section loader table into React components. Each section lives in
 * its own module under `sections/`, and the pieces they share (page header,
 * scroll container, state banners, table cells) live in `console/primitives`.
 *
 * The loader table itself lives in `console/section-loaders.ts`, not here, and
 * that separation is load-bearing: the admin route's `loader` is not code-split
 * by `autoCodeSplitting` (only `component` is), so a route importing its
 * prefetch entry point from this file drags the console shell, the sidebar, the
 * icon set and the realtime hub into the initial JavaScript graph of every page
 * in the app. The bundle budget caught exactly that — 605.0 kB against a
 * 450.0 kB ceiling.
 *
 * Sections render live platform data only. When an endpoint is unavailable
 * they surface a loading / error / empty state rather than seed values. */

import { lazy, Suspense, type ComponentType } from "react";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import { AdminSidebar } from "@/features/admin/console/sidebar";
import { PageScroll, SectionSkeleton } from "@/features/admin/console/primitives";
import {
  ADMIN_SECTION_LOADERS,
  preloadAdminSection,
  type AdminSectionLoader,
} from "@/features/admin/console/section-loaders";
import { useAdminRealtime } from "@/features/admin/use-admin-realtime";
import { adminSectionLabel, type AdminSectionId } from "@/features/admin/admin-console-data";

/** Turn one loader entry into a lazy component.
 *
 *  Every section used to be imported eagerly, which put all eighteen into a
 *  single route chunk — 503.8 kB against a 500 kB budget, and an operator
 *  opening Overview downloaded the AI observability dashboard to get there.
 *  Each is now its own chunk, fetched when its URL is visited — or, since
 *  `preloadAdminSection` exists, when the operator's pointer lands on its row. */
function sectionComponent(entry: AdminSectionLoader): ComponentType {
  return lazy(async () => {
    const loaded = await entry.load();
    const Section = loaded[entry.exportName] as ComponentType | undefined;
    if (Section === undefined) {
      throw new Error(`Admin section module has no export named ${entry.exportName}`);
    }
    return {
      default: entry.scroll
        ? function ScrolledSection() {
            return (
              <PageScroll>
                <Section />
              </PageScroll>
            );
          }
        : Section,
    };
  });
}

/* Built once at module scope: `lazy()` memoises per call, so creating these
   inside the component would throw the resolved module away on every render. */
const SECTION_COMPONENTS: Record<AdminSectionId, ComponentType> = Object.fromEntries(
  Object.entries(ADMIN_SECTION_LOADERS).map(([id, entry]) => [id, sectionComponent(entry)]),
) as Record<AdminSectionId, ComponentType>;

/** The console body for one section. The section comes from the route, not
 *  component state, so every surface is linkable and survives refresh and
 *  back/forward. */
export function AdminConsole({ section: id }: { readonly section: AdminSectionId }) {
  const Component = SECTION_COMPONENTS[id];

  /* One ref-counted socket per distinct subject for the whole console, mounted
     here rather than per section so switching sections does not tear down and
     re-open the connection. */
  useAdminRealtime(id);

  return (
    /* The section name is in the chrome, which sits *outside* the Suspense
       boundary below — so it repaints on the click itself rather than after the
       chunk lands. During a cold navigation it is the only thing on screen that
       names where you are going. */
    <SurfaceFrame title={`Admin · ${adminSectionLabel(id)}`} icon={<Icons.Shield />}>
      <AdminSidebar section={id} onPreloadSection={preloadAdminSection} />
      {/* Keyed on the section so React tears down the previous section's tree
          instead of holding it while the next chunk loads. The fallback is
          page-shaped: a blank pane for the duration of a chunk fetch reads as a
          broken page, and the geometry has to survive the swap or the content
          jumps when it arrives. */}
      <Suspense key={id} fallback={<SectionSkeleton />}>
        <Component />
      </Suspense>
    </SurfaceFrame>
  );
}
