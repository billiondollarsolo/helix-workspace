import { createLazyFileRoute } from "@tanstack/react-router";
import { AdminDashboard } from "@/features/admin/admin-dashboard";

export const Route = createLazyFileRoute("/_shell/admin/")({
  component: AdminRoute,
});

function AdminRoute() {
  return <AdminDashboard />;
}
