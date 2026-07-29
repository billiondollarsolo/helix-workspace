import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SheetsShell } from "@/features/sheets/sheets-shell";
import { enforceFullWorkspaceRoute } from "@/components/mvp-boundary";

/** `?sheet=<id>` opens straight into that spreadsheet's editor (used by Drive's New). */
interface SheetsRouteSearch {
  readonly sheet?: string;
  readonly open?: "office";
  readonly q?: string;
}

function validateSheetsRouteSearch(search: Record<string, unknown>): SheetsRouteSearch {
  const sheet =
    typeof search.sheet === "string" && search.sheet.trim().length > 0 ? search.sheet : undefined;
  const open = search.open === "office" ? "office" : undefined;
  const q =
    typeof search.q === "string" && search.q.trim().length > 0 ? search.q.trim() : undefined;
  return {
    ...(sheet === undefined ? {} : { sheet }),
    ...(open === undefined ? {} : { open }),
    ...(q === undefined ? {} : { q }),
  };
}

export const Route = createFileRoute("/_shell/sheets/")({
  beforeLoad: () => enforceFullWorkspaceRoute(),
  validateSearch: (search): SheetsRouteSearch => validateSheetsRouteSearch(search),
  component: SheetsRoute,
});

function SheetsRoute() {
  const { sheet, open, q } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <SheetsShell
      initialSheetId={sheet}
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
