import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/shell";
import { workspaceSummaryQueryOptions } from "@/features/workspace/queries";

export const Route = createFileRoute("/_shell")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(workspaceSummaryQueryOptions());
  },
  component: AppShell,
  pendingComponent: () => (
    <div className="flex min-h-screen bg-background text-foreground">
      <div className="w-16 shrink-0 border-r border-sidebar-border bg-sidebar" />
      <div className="workspace-frame flex-1">
        <div className="top-bar" />
        <div className="route-skeleton" />
      </div>
    </div>
  ),
});
