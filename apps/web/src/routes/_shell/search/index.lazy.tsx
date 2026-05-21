import { createLazyFileRoute, useNavigate } from "@tanstack/react-router";
import type { GlobalSearchHit } from "@/features/search/api";
import { navigationTargetForSearchHit } from "@/features/search/navigation";
import {
  SearchResultsShell,
  type SearchRouteSearchState,
} from "@/features/search/search-results-shell";

export const Route = createLazyFileRoute("/_shell/search/")({
  component: SearchRoute,
});

function SearchRoute() {
  const navigate = useNavigate();
  const search = Route.useSearch();

  return (
    <SearchResultsShell
      initialQuery={search.q}
      initialTypes={search.types}
      onOpenSearchHit={(hit) => openSearchHit(hit, navigate)}
      onSearchStateChange={(state) => {
        void navigate({
          to: "/search",
          search: routeSearchStateForNavigate(state),
          replace: true,
        });
      }}
    />
  );
}

type Navigate = ReturnType<typeof useNavigate>;

function openSearchHit(hit: GlobalSearchHit, navigate: Navigate): void {
  const target = navigationTargetForSearchHit(hit);
  switch (target.route) {
    case "/mail":
      void navigate({
        to: "/mail",
        search: { thread: target.thread, message: target.message },
      });
      return;
    case "/chat":
      void navigate({
        to: "/chat",
        search: { room: target.room, message: target.message },
      });
      return;
    case "/drive":
      void navigate({
        to: "/drive",
        search: { file: target.file },
      });
      return;
    case "/calendar":
      void navigate({
        to: "/calendar",
        search: { event: target.event },
      });
      return;
  }
}

function routeSearchStateForNavigate(state: SearchRouteSearchState): SearchRouteSearchState {
  return {
    ...(state.q === undefined ? {} : { q: state.q }),
    ...(state.types === undefined || state.types.length === 0 ? {} : { types: state.types }),
  };
}
