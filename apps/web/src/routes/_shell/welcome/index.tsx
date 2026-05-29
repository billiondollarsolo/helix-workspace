import { createFileRoute } from "@tanstack/react-router";
import { WelcomeDashboard } from "@/features/welcome/welcome-dashboard";

export const Route = createFileRoute("/_shell/welcome/")({
  component: WelcomeDashboard,
});
