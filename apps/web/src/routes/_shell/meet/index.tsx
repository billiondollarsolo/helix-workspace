import { createFileRoute } from "@tanstack/react-router";
import { MeetShell } from "@/features/meet/meet-shell";

export const Route = createFileRoute("/_shell/meet/")({
  component: MeetShell,
});
