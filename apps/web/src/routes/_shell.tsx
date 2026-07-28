import { createFileRoute, redirect } from "@tanstack/react-router";
import { AppShell } from "@/components/shell";
import { getSessionUser, getStoredAccessToken } from "@/lib/auth";

export const Route = createFileRoute("/_shell")({
  // Auth gate: browser users normally arrive with a Better-Auth session.
  // OAuth client-credential flows used by browser smoke tests and external
  // clients keep a bearer token in local storage instead; backend requests
  // still validate that token and its scopes.
  beforeLoad: async () => {
    const user = await getSessionUser();
    if (user === null && getStoredAccessToken() === null) {
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
