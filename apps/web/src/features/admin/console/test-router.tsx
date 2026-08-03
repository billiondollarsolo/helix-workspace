/* A minimal memory router for admin section tests.
 *
 * Sections that render `AdminRelatedNav` now use real `<Link>`s rather than raw
 * `<a href>` anchors — an anchor inside the SPA was a full document reload,
 * which made the "related pages" shortcut the slowest navigation in the
 * console. `<Link>` needs a router in context, and these tests mount one
 * section on its own.
 *
 * Only what the sections actually use: the `/admin/$section` path so `<Link to>`
 * resolves, and a memory history so nothing touches the address bar. Tests that
 * exercise routing itself build their own router (`admin-console.test.tsx`);
 * this is for the ones where the router is incidental scaffolding.
 */

import { createElement, type ReactElement, type ReactNode } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

/** Wrap a section element in a router rooted at `/admin/<section>`. */
export function withAdminRouter(children: ReactNode, section = "overview"): ReactElement {
  const rootRoute = createRootRoute();
  const sectionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/admin/$section",
    component: () => createElement("div", null, children),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([sectionRoute]),
    history: createMemoryHistory({ initialEntries: [`/admin/${section}`] }),
  });
  /* The generated route tree is what `RouterProvider` is typed against; this
     ad-hoc tree is structurally fine but not that type. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createElement(RouterProvider as any, { router });
}
