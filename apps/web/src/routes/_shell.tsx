import { createFileRoute, redirect, retainSearchParams } from "@tanstack/react-router";
import { AppShell } from "@/components/shell";
import { isSettingsSectionId, type SettingsSectionId } from "@/components/shell/overlay-context";
import { sessionUserQueryOptions } from "@/lib/auth";

interface ShellSearch {
  /** The open settings section, `?settings=<section>[/<tab>]`, on every app. */
  readonly settings?: SettingsSectionId;
}

export const Route = createFileRoute("/_shell")({
  validateSearch: (search: Record<string, unknown>): ShellSearch =>
    isSettingsSectionId(search.settings) ? { settings: search.settings } : {},
  // An app's own navigation (a folder, a thread) keeps settings open.
  search: { middlewares: [retainSearchParams(["settings"])] },
  beforeLoad: async ({ location, context }) => {
    // Keep a verified identity during transient outages. The shared query
    // revalidates stale sessions without replacing cached data on HTTP errors.
    const user = await context.queryClient.ensureQueryData({
      ...sessionUserQueryOptions(),
      revalidateIfStale: true,
    });
    if (user === null || user.passwordChangeRequired) {
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
