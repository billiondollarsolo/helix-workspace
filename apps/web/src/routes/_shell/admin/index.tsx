import { createFileRoute } from "@tanstack/react-router";
import { prefetchAdminDashboardQueries } from "@/features/admin/admin-dashboard";

export const Route = createFileRoute("/_shell/admin/")({
  loader: async ({ context }) => {
    await prefetchAdminDashboardQueries(context.queryClient);
  },
});
