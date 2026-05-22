import { createFileRoute } from "@tanstack/react-router";
import { SlidesShell } from "@/features/slides/slides-shell";

/** `?deck=<id>` opens straight into that deck's editor (used by Drive's New). */
interface SlidesRouteSearch {
  readonly deck?: string;
}

function validateSlidesRouteSearch(search: Record<string, unknown>): SlidesRouteSearch {
  const deck =
    typeof search.deck === "string" && search.deck.trim().length > 0 ? search.deck : undefined;
  return deck === undefined ? {} : { deck };
}

export const Route = createFileRoute("/_shell/slides/")({
  validateSearch: (search): SlidesRouteSearch => validateSlidesRouteSearch(search),
  component: SlidesRoute,
});

function SlidesRoute() {
  const { deck } = Route.useSearch();
  return <SlidesShell initialDeckId={deck} />;
}
