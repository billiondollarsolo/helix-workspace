import { createFileRoute } from "@tanstack/react-router";
import { enforceFullWorkspaceRoute } from "@/components/mvp-boundary";
import { MeetShell } from "@/features/meet/meet-shell";

export const Route = createFileRoute("/_shell/meet/")({
  beforeLoad: () => enforceFullWorkspaceRoute(),
  component: MeetShell,
});
