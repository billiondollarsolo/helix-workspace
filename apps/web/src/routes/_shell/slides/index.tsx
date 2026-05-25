import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SlidesShell, type SlidesViewRouteState } from "@/features/slides/slides-shell";

/** `?deck=<id>` opens straight into that deck's editor (used by Drive's New). */
interface SlidesRouteSearch {
  readonly deck?: string;
  readonly comment?: string;
}

function validateSlidesRouteSearch(search: Record<string, unknown>): SlidesRouteSearch {
  const deck =
    typeof search.deck === "string" && search.deck.trim().length > 0 ? search.deck : undefined;
  const comment =
    typeof search.comment === "string" && search.comment.trim().length > 0
      ? search.comment
      : undefined;
  return {
    ...(deck === undefined ? {} : { deck }),
    ...(comment === undefined ? {} : { comment }),
  };
}

export const Route = createFileRoute("/_shell/slides/")({
  validateSearch: (search): SlidesRouteSearch => validateSlidesRouteSearch(search),
  component: SlidesRoute,
});

function SlidesRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <SlidesShell
      routeState={slidesRouteStateFromSearch(search)}
      onRouteStateChange={(nextState) => {
        void navigate({
          replace: true,
          search: () => slidesRouteSearchFromState(nextState),
        });
      }}
    />
  );
}

function slidesRouteStateFromSearch(search: SlidesRouteSearch): SlidesViewRouteState {
  return {
    deckId: search.deck ?? null,
    commentId: search.comment ?? null,
  };
}

function slidesRouteSearchFromState(state: SlidesViewRouteState): SlidesRouteSearch {
  return {
    deck: state.deckId ?? undefined,
    comment: state.commentId ?? undefined,
  };
}
