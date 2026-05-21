import { queryOptions } from "@tanstack/react-query";

export interface WorkspaceSummary {
  unreadNotifications: number;
  installedPlugins: number;
  activeRouteCount: number;
  recentActivity: readonly string[];
}

const workspaceSummary: WorkspaceSummary = {
  unreadNotifications: 3,
  installedPlugins: 9,
  activeRouteCount: 9,
  recentActivity: [
    "Platform shell initialized",
    "Web SDK contribution registry ready",
    "Theme bootstrap applied before React mount"
  ]
};

export function workspaceSummaryQueryOptions() {
  return queryOptions({
    queryKey: ["workspace", "summary"],
    queryFn: () => workspaceSummary,
    staleTime: 60_000
  });
}
