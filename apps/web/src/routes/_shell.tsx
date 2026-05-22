import { createFileRoute, redirect } from "@tanstack/react-router";
import { AppShell } from "@/components/shell";
import { getSessionUser } from "@/lib/auth";

export const Route = createFileRoute("/_shell")({
  // Auth gate: every workspace surface lives under `_shell`. Resolve the
  // Better-Auth session before loading and bounce unauthenticated visitors
  // to the login page.
  beforeLoad: async () => {
    const user = await getSessionUser();
    if (user === null) {
      // TanStack Router signals navigation by throwing a redirect.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: "/login" });
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
