import { createFileRoute } from "@tanstack/react-router";
import { SheetsShell } from "@/features/sheets/sheets-shell";

/** `?sheet=<id>` opens straight into that spreadsheet's editor (used by Drive's New). */
interface SheetsRouteSearch {
  readonly sheet?: string;
}

function validateSheetsRouteSearch(search: Record<string, unknown>): SheetsRouteSearch {
  const sheet =
    typeof search.sheet === "string" && search.sheet.trim().length > 0 ? search.sheet : undefined;
  return sheet === undefined ? {} : { sheet };
}

export const Route = createFileRoute("/_shell/sheets/")({
  validateSearch: (search): SheetsRouteSearch => validateSheetsRouteSearch(search),
  component: SheetsRoute,
});

function SheetsRoute() {
  const { sheet } = Route.useSearch();
  return <SheetsShell initialSheetId={sheet} />;
}
