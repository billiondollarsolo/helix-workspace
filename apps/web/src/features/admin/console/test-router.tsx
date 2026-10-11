/* A minimal memory router for admin section tests: sections render real
 * `<Link>`s, which need a router in context. Only the `/admin/$section` path
 * and a memory history; tests of routing itself build their own router. */

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
