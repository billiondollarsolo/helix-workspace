import { Shield as ShieldIcon } from "lucide-react";
/* Helix Admin console — the surface shell.
 *
 * This file owns the chrome: the grouped sidebar, the admin search bar, and
 * the page container every section renders into. Each section lives in its
 * own module and is code-split through `console/section-loaders.ts`, which is
 * kept free of React so the route's `loader` does not pull the console into
 * every page's initial bundle.
 *
 * Every section renders inside the same page container, so padding, scroll
 * and content width are identical across the console; a section is just a
 * `PageHeading` followed by its content. */

import { SurfaceFrame } from "@/components/shell";
import { adminSectionLabel, type AdminSectionId } from "@/features/admin/admin-console-data";
import { AdminSearch } from "@/features/admin/console/admin-search";
import { SectionSkeleton } from "@/features/admin/console/primitives";
import {
  ADMIN_SECTION_LOADERS,
  preloadAdminSection,
  type AdminSectionLoader,
} from "@/features/admin/console/section-loaders";
import { AdminSidebar } from "@/features/admin/console/sidebar";
import { useAdminRealtime } from "@/features/admin/use-admin-realtime";
import { lazy, Suspense, type ComponentType } from "react";

/** Turn one loader entry into a lazy component. */
function sectionComponent(entry: AdminSectionLoader): ComponentType {
  return lazy(async () => {
    const loaded = await entry.load();
    const Section = loaded[entry.exportName] as ComponentType | undefined;
    if (Section === undefined) {
      throw new Error(`Admin section module has no export named ${entry.exportName}`);
    }
    return { default: Section };
  });
}

/* Built once at module scope: `lazy()` memoises per call, so creating these
   inside the component would throw the resolved module away on every render. */
const SECTION_COMPONENTS: Record<AdminSectionId, ComponentType> = Object.fromEntries(
  Object.entries(ADMIN_SECTION_LOADERS).map(([id, entry]) => [id, sectionComponent(entry)]),
) as Record<AdminSectionId, ComponentType>;

/** The console body for one section. The section comes from the route, so
 *  every page is linkable and survives refresh and back/forward. */
export function AdminConsole({ section: id }: { readonly section: AdminSectionId }) {
  const Component = SECTION_COMPONENTS[id];

  /* One ref-counted socket for the whole console, so switching sections does
     not tear down and re-open the connection. */
  useAdminRealtime(id);

  return (
    <SurfaceFrame
      title={`Administration · ${adminSectionLabel(id)}`}
      icon={<ShieldIcon size={16} />}
      navigationKey={id}
      searchContent={<AdminSearch />}
    >
      <AdminSidebar section={id} onPreloadSection={preloadAdminSection} />
      <div className="admin-main">
        {/* Keyed on the section so the previous page is torn down instead of
            held while the next one's code loads. */}
        <div className="admin-page" tabIndex={0} key={id}>
          <div className="admin-page-inner">
            <Suspense fallback={<SectionSkeleton />}>
              <Component />
            </Suspense>
          </div>
        </div>
      </div>
    </SurfaceFrame>
  );
}
