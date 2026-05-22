import { createFileRoute } from "@tanstack/react-router";
import { AdminConsole } from "@/features/admin/admin-console";

export const Route = createFileRoute("/_shell/admin/")({
  component: AdminConsole,
});
