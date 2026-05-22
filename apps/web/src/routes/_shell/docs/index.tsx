import { createFileRoute } from "@tanstack/react-router";
import { DocsShell } from "@/features/docs/docs-shell";

/** `?doc=<id>` opens straight into that document's editor (used by Drive's New). */
interface DocsRouteSearch {
  readonly doc?: string;
}

function validateDocsRouteSearch(search: Record<string, unknown>): DocsRouteSearch {
  const doc =
    typeof search.doc === "string" && search.doc.trim().length > 0 ? search.doc : undefined;
  return doc === undefined ? {} : { doc };
}

export const Route = createFileRoute("/_shell/docs/")({
  validateSearch: (search): DocsRouteSearch => validateDocsRouteSearch(search),
  component: DocsRoute,
});

function DocsRoute() {
  const { doc } = Route.useSearch();
  return <DocsShell initialDocumentId={doc} />;
}
