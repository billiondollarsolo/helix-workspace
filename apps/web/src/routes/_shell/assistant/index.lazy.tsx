import { createLazyFileRoute } from "@tanstack/react-router";
import { CoreAppGate } from "@/components/core-app-gate";
import { AssistantShell } from "@/features/assistant/assistant-shell";

export const Route = createLazyFileRoute("/_shell/assistant/")({
  component: AssistantRoute,
});

function AssistantRoute() {
  return (
    <CoreAppGate app="assistant">
      <AssistantShell />
    </CoreAppGate>
  );
}
