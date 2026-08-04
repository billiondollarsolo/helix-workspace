import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { enforceFullWorkspaceRoute } from "@/components/mvp-boundary";
import { NativePdfViewer, type NativePdfViewRouteState } from "@/features/pdf/native-pdf-viewer";

interface PdfRouteSearch {
  readonly page?: number;
  readonly zoom?: number;
  readonly annotation?: string;
  readonly comment?: string;
  readonly folder?: string;
}

export const Route = createFileRoute("/_shell/pdf/$objectId")({
  beforeLoad: () => enforceFullWorkspaceRoute(),
  validateSearch: (search): PdfRouteSearch => validatePdfRouteSearch(search),
  component: PdfRoute,
});

function PdfRoute() {
  const { objectId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <NativePdfViewer
      objectId={objectId}
      routeState={pdfRouteStateFromSearch(search)}
      onRouteStateChange={(nextState) => {
        void navigate({
          replace: true,
          search: () => pdfRouteSearchFromState(nextState),
        });
      }}
    />
  );
}

function validatePdfRouteSearch(search: Record<string, unknown>): PdfRouteSearch {
  return pdfRouteSearchFromState({
    page: positiveIntegerSearchValue(search.page) ?? 1,
    zoom: boundedIntegerSearchValue(search.zoom, 50, 200) ?? 100,
    commentId: nonEmptySearchValue(search.annotation) ?? nonEmptySearchValue(search.comment),
    sourceFolderId: nonEmptySearchValue(search.folder),
  });
}

function pdfRouteStateFromSearch(search: PdfRouteSearch): NativePdfViewRouteState {
  return {
    page: search.page ?? 1,
    zoom: search.zoom ?? 100,
    commentId: search.annotation ?? search.comment ?? null,
    sourceFolderId: search.folder ?? null,
  };
}

function pdfRouteSearchFromState(state: NativePdfViewRouteState): PdfRouteSearch {
  return {
    page: state.page === 1 ? undefined : state.page,
    zoom: state.zoom === 100 ? undefined : state.zoom,
    comment: state.commentId ?? undefined,
    folder: state.sourceFolderId ?? undefined,
  };
}

function positiveIntegerSearchValue(value: unknown): number | null {
  let parsed = Number.NaN;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string") {
    parsed = Number.parseInt(value, 10);
  }
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function boundedIntegerSearchValue(value: unknown, min: number, max: number): number | null {
  const parsed = positiveIntegerSearchValue(value);
  if (parsed === null) {
    return null;
  }
  return Math.min(max, Math.max(min, parsed));
}

function nonEmptySearchValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
