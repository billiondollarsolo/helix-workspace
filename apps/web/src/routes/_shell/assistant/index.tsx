import { createFileRoute } from "@tanstack/react-router";
import { AssistantSurface } from "@/features/assistant/assistant-surface";

export const Route = createFileRoute("/_shell/assistant/")({
  component: AssistantSurface,
});
