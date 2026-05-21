import { createLazyFileRoute } from "@tanstack/react-router";
import { CoreAppGate } from "@/components/core-app-gate";
import { DocsShell } from "@/features/docs/docs-shell";

export const Route = createLazyFileRoute("/_shell/docs/")({
  component: DocsRoute,
});

function DocsRoute() {
  const { doc } = Route.useSearch();

  return (
    <CoreAppGate app="docs">
      <DocsShell initialDocumentId={doc} />
    </CoreAppGate>
  );
}
