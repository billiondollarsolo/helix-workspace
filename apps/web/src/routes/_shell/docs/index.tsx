import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { DocsShell } from "@/features/docs/docs-shell";
import { CORE_WORKSPACE_STORAGE_ONLY } from "@/components/apps";

/** `?doc=<id>` opens straight into that document's editor (used by Drive's New). */
interface DocsRouteSearch {
  readonly doc?: string;
  readonly open?: "office";
  readonly q?: string;
}

function validateDocsRouteSearch(search: Record<string, unknown>): DocsRouteSearch {
  const doc =
    typeof search.doc === "string" && search.doc.trim().length > 0 ? search.doc : undefined;
  const open = search.open === "office" ? "office" : undefined;
  const q =
    typeof search.q === "string" && search.q.trim().length > 0 ? search.q.trim() : undefined;
  return {
    ...(doc === undefined ? {} : { doc }),
    ...(open === undefined ? {} : { open }),
    ...(q === undefined ? {} : { q }),
  };
}

export const Route = createFileRoute("/_shell/docs/")({
  beforeLoad: () => {
    if (CORE_WORKSPACE_STORAGE_ONLY) {
      // TanStack Router signals navigation by throwing a redirect.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: "/drive" });
    }
  },
  validateSearch: (search): DocsRouteSearch => validateDocsRouteSearch(search),
  component: DocsRoute,
});

function DocsRoute() {
  const { doc, open, q } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <DocsShell
      initialDocumentId={doc}
      initialOpenMode={open}
      initialSearchQuery={q ?? ""}
      onSearchQueryChange={(nextQuery) => {
        void navigate({
          replace: true,
          search: (previous) => ({
            ...previous,
            q: nextQuery.trim().length > 0 ? nextQuery : undefined,
          }),
        });
      }}
    />
  );
}
