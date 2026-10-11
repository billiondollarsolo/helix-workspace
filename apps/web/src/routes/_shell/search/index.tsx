import { SurfaceFrame } from "@/components/shell";
import { validateSearchRouteSearch, type SearchRouteSearch } from "@/features/search/route-search";
import { SearchResultsShell } from "@/features/search/search-results-shell";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Search as SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/_shell/search/")({
  validateSearch: (search): SearchRouteSearch => validateSearchRouteSearch(search),
  component: SearchRoute,
});

function SearchRoute() {
  const { q = "", type } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [draft, setDraft] = useState(q);

  useEffect(() => {
    setDraft(q);
  }, [q]);

  return (
    <SurfaceFrame
      title="Search"
      icon={<SearchIcon size={16} />}
      searchPlaceholder="Search Helix"
      searchValue={draft}
      onSearchChange={setDraft}
      onSearchSubmit={(value) => {
        const next = value.trim();
        void navigate({ search: (previous) => ({ ...previous, q: next || undefined }) });
      }}
    >
      <SearchResultsShell
        query={q}
        filter={type}
        onFilterChange={(next) => {
          void navigate({ search: (previous) => ({ ...previous, type: next }), replace: true });
        }}
      />
    </SurfaceFrame>
  );
}
