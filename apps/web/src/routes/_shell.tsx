import { createFileRoute, redirect } from "@tanstack/react-router";
import { AppShell } from "@/components/shell";
import { sessionUserQueryOptions } from "@/lib/auth";

export const Route = createFileRoute("/_shell")({
  beforeLoad: async ({ location, context }) => {
    // Keep a verified identity during transient outages. The shared query
    // revalidates stale sessions without replacing cached data on HTTP errors.
    const user = await context.queryClient.ensureQueryData({
      ...sessionUserQueryOptions(),
      revalidateIfStale: true,
    });
    if (user === null) {
      // TanStack Router signals navigation by throwing a redirect.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: "/login", search: { returnTo: location.href } });
    }
  },
  component: AppShell,
  pendingComponent: () => (
    <div className="app">
      <div className="rail" />
      <div className="workspace">
        <div className="topbar" />
        <div className="workspace-body" />
      </div>
    </div>
  ),
});
