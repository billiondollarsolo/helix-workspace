import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SheetsShell } from "@/features/sheets/sheets-shell";
import { enforceFullWorkspaceRoute } from "@/components/mvp-boundary";
import {
  optionalEnumSearchParam,
  optionalNonBlankStringSearchParam,
  optionalStringSearchParam,
} from "@/lib/search-params";

const OPEN_MODES = ["office"] as const;

/** `?sheet=<id>` opens straight into that spreadsheet's editor (used by Drive's New). */
interface SheetsRouteSearch {
  readonly sheet?: string;
  readonly open?: "office";
  readonly q?: string;
}

function validateSheetsRouteSearch(search: Record<string, unknown>): SheetsRouteSearch {
  const sheet = optionalNonBlankStringSearchParam(search.sheet);
  const open = optionalEnumSearchParam(search.open, OPEN_MODES);
  const q = optionalStringSearchParam(search.q);
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
