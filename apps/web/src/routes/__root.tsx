import { Link, Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useRef } from "react";
import type { RouterContext } from "@/router-context";

const Devtools = lazy(() =>
  import("@/components/devtools").then((module) => ({ default: module.Devtools })),
);

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootRoute,
  errorComponent: RouteErrorState,
  notFoundComponent: RouteNotFoundState,
});

export function RouteErrorState({
  error,
  reset,
}: {
  readonly error: unknown;
  readonly reset?: (() => void) | undefined;
}) {
  const mainRef = useRouteStateFocus();
  const details = routeErrorDetails(error);
  return (
    <main ref={mainRef} className="route-state" tabIndex={-1} aria-labelledby="route-error-title">
      <div className="route-state-card">
        <p className="route-state-eyebrow">Helix Workspace</p>
        <h1 id="route-error-title">We couldn’t load this view</h1>
        <p>Your work is still safe. Retry the view, or return home and open it again.</p>
        <div className="route-state-actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              if (reset !== undefined) {
                reset();
              } else {
                window.location.reload();
              }
            }}
          >
            Retry
          </button>
          <Link className="btn" to="/">
            Return home
          </Link>
        </div>
        {details === null ? null : (
          <details className="route-state-details">
            <summary>Developer details</summary>
            <pre>{details}</pre>
          </details>
        )}
      </div>
    </main>
  );
}

export function RouteNotFoundState() {
  const mainRef = useRouteStateFocus();
  return (
    <main
      ref={mainRef}
      className="route-state"
      tabIndex={-1}
      aria-labelledby="route-not-found-title"
    >
      <div className="route-state-card">
        <p className="route-state-eyebrow">404</p>
        <h1 id="route-not-found-title">That page isn’t here</h1>
        <p>The link may be out of date, or the workspace item may have moved.</p>
        <div className="route-state-actions">
          <Link className="btn primary" to="/">
            Return home
          </Link>
        </div>
      </div>
    </main>
  );
}

export function routeErrorDetails(
  error: unknown,
  exposeDetails = import.meta.env.DEV,
): string | null {
  if (!exposeDetails) {
    return null;
  }
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function useRouteStateFocus() {
  const mainRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    mainRef.current?.focus();
  }, []);
  return mainRef;
}

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
