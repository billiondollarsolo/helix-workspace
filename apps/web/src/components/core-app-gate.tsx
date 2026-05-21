import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PackageX } from "lucide-react";
import type { ReactNode } from "react";
import {
  coreAppsShellQueryOptions,
  type CoreAppId,
} from "@/features/admin/core-apps-api";

/**
 * Gates a core-app route on its enablement.
 *
 * Core apps are toggleable platform modules. When an org admin disables a core
 * app (or this deployment's role does not run it), the app's backend routes
 * are not served at all — so the SPA must render a clean "app disabled" state
 * instead of a broken screen. While enablement is loading we render the app
 * optimistically to avoid a flash.
 */
export function CoreAppGate({
  app,
  children,
}: {
  readonly app: CoreAppId;
  readonly children: ReactNode;
}): ReactNode {
  const query = useQuery(coreAppsShellQueryOptions());
  const status = query.data;
  // Optimistic while loading or if the query failed — the backend still
  // enforces enablement, so a wrong guess here is cosmetic.
  if (status === undefined) {
    return children;
  }
  const entry = status.apps.find((candidate) => candidate.id === app);
  if (entry === undefined || entry.registered) {
    return children;
  }

  return <CoreAppDisabledState appName={entry.name} />;
}

function CoreAppDisabledState({ appName }: { readonly appName: string }): ReactNode {
  return (
    <section
      aria-label={`${appName} is disabled`}
      className="mx-auto flex max-w-md flex-col items-center gap-4 px-6 py-24 text-center"
    >
      <span className="grid size-14 place-items-center rounded-2xl bg-surface-container-high text-muted-foreground">
        <PackageX aria-hidden="true" size={28} />
      </span>
      <h1 className="text-xl font-medium text-foreground">{appName} is disabled</h1>
      <p className="text-sm text-muted-foreground">
        The {appName} app has been turned off for this workspace. An organization
        administrator can re-enable it from core-app settings.
      </p>
      <Link
        className="text-sm font-medium text-primary underline-offset-4 hover:underline"
        to="/admin"
      >
        Go to Admin
      </Link>
    </section>
  );
}
