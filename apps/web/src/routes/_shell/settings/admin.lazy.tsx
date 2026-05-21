import { Navigate, createLazyFileRoute } from "@tanstack/react-router";

export const Route = createLazyFileRoute("/_shell/settings/admin")({
  component: SettingsAdminRoute,
});

function SettingsAdminRoute() {
  return <Navigate to="/admin" replace />;
}
