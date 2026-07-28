import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { SlidesShell, type SlidesViewRouteState } from "@/features/slides/slides-shell";
import { CORE_WORKSPACE_STORAGE_ONLY } from "@/components/apps";

/** `?deck=<id>` opens straight into that deck's editor (used by Drive's New). */
interface SlidesRouteSearch {
  readonly deck?: string;
  readonly comment?: string;
  readonly open?: "office";
  readonly q?: string;
}

function validateSlidesRouteSearch(search: Record<string, unknown>): SlidesRouteSearch {
  const deck =
    typeof search.deck === "string" && search.deck.trim().length > 0 ? search.deck : undefined;
  const comment =
    typeof search.comment === "string" && search.comment.trim().length > 0
      ? search.comment
      : undefined;
  const open = search.open === "office" ? "office" : undefined;
  const q =
    typeof search.q === "string" && search.q.trim().length > 0 ? search.q.trim() : undefined;
  return {
    ...(deck === undefined ? {} : { deck }),
    ...(comment === undefined ? {} : { comment }),
    ...(open === undefined ? {} : { open }),
    ...(q === undefined ? {} : { q }),
  };
}

export const Route = createFileRoute("/_shell/slides/")({
  beforeLoad: () => {
    if (CORE_WORKSPACE_STORAGE_ONLY) {
      // TanStack Router signals navigation by throwing a redirect.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: "/drive" });
    }
  },
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
          search: (previous) => ({
            ...slidesRouteSearchFromState(nextState),
            q: typeof previous.q === "string" ? previous.q : undefined,
          }),
        });
      }}
      initialSearchQuery={search.q ?? ""}
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

function slidesRouteStateFromSearch(search: SlidesRouteSearch): SlidesViewRouteState {
  return {
    deckId: search.deck ?? null,
    commentId: search.comment ?? null,
    openMode: search.open ?? null,
    searchQuery: search.q ?? "",
  };
}

function slidesRouteSearchFromState(state: SlidesViewRouteState): SlidesRouteSearch {
  return {
    deck: state.deckId ?? undefined,
    comment: state.commentId ?? undefined,
    open: state.openMode === "office" ? "office" : undefined,
    q: state.searchQuery.trim().length > 0 ? state.searchQuery : undefined,
  };
}
