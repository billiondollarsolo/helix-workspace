import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import type { RouterContext } from "@/router-context";

const Devtools = lazy(() => import("@/components/devtools").then((module) => ({ default: module.Devtools })));

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootRoute,
  errorComponent: ({ error }) => (
    <main className="route-state">
      <h1>Something went wrong</h1>
      <p>{error.message}</p>
    </main>
  ),
  notFoundComponent: () => (
    <main className="route-state">
      <h1>Not found</h1>
      <p>This route is not registered in the Helix shell.</p>
    </main>
  )
});

function RootRoute() {
  return (
    <>
      <Outlet />
      {import.meta.env.DEV ? (
        <Suspense fallback={null}>
          <Devtools />
        </Suspense>
      ) : null}
    </>
  );
}
