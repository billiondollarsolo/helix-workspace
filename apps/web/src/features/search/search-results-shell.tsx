/* Search results for `/search?q=`. A ranked list of mail, files, chat messages
   and events from `search.query`, people from the directory, and app filter
   chips. The query itself is edited in the top bar. */

import {
  CalendarDays,
  Folder,
  Inbox,
  MessageSquare,
  Search as SearchIcon,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import { peopleDirectoryQueryOptions, type PeopleDirectoryPerson } from "@/features/people/api";
import type { GlobalSearchHit, GlobalSearchType } from "./api";
import { globalSearchQueryOptions, invalidateGlobalSearch } from "./queries";
import type { SearchFilter } from "./route-search";
import {
  SEARCH_TYPE_LABELS,
  SEARCH_TYPE_ORDER,
  searchHitDetail,
  searchHitSnippet,
  searchHitTarget,
  searchHitTitle,
} from "./search-hits";

/** `search.query` caps a page at 50 hits. */
const PAGE_SIZES = [20, 50] as const;
const PEOPLE_IN_ALL = 4;

const FILTERS: readonly { readonly id: SearchFilter | undefined; readonly label: string }[] = [
  { id: undefined, label: "All" },
  ...SEARCH_TYPE_ORDER.map((type) => ({ id: type, label: SEARCH_TYPE_LABELS[type] })),
  { id: "people", label: "People" },
];

const TYPE_ICONS: Readonly<Record<GlobalSearchType, LucideIcon>> = {
  mail: Inbox,
  drive: Folder,
  chat: MessageSquare,
  calendar: CalendarDays,
};

export interface SearchResultsShellProps {
  readonly query: string;
  readonly filter: SearchFilter | undefined;
  readonly onFilterChange: (filter: SearchFilter | undefined) => void;
}

export function SearchResultsShell({ query, filter, onFilterChange }: SearchResultsShellProps) {
  const normalized = query.trim();
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(PAGE_SIZES[0]);
  const queryClient = useQueryClient();
  const wantsContent = normalized.length > 0 && filter !== "people";
  const wantsPeople = normalized.length > 0 && (filter === undefined || filter === "people");
  const searchInput = {
    query: normalized,
    ...(filter === undefined || filter === "people" ? {} : { types: [filter] }),
    limit: pageSize,
  };
  const content = useQuery({ ...globalSearchQueryOptions(searchInput), enabled: wantsContent });
  const people = useQuery({
    ...peopleDirectoryQueryOptions({ query: normalized, limit: filter === "people" ? 25 : 8 }),
    enabled: wantsPeople,
  });

  const hits = wantsContent ? (content.data?.hits ?? []) : [];
  const persons = wantsPeople
    ? (people.data ?? []).slice(0, filter === "people" ? undefined : PEOPLE_IN_ALL)
    : [];
  const loading = (wantsContent && content.isLoading) || (wantsPeople && people.isLoading);
  const failed = (wantsContent && content.isError) || (filter === "people" && people.isError);
  const total = (content.data?.estimatedTotalHits ?? hits.length) + persons.length;

  return (
    <div className="search-page">
      <h1 className="sr-only">Search results</h1>
      <div className="search-chips" role="group" aria-label="Filter results by app">
        {FILTERS.map((option) => (
          <button
            key={option.label}
            type="button"
            className="search-chip"
            aria-pressed={filter === option.id}
            onClick={() => {
              setPageSize(PAGE_SIZES[0]);
              onFilterChange(option.id);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      <p className="search-results-meta" aria-live="polite">
        {statusText({ query: normalized, loading, failed, total })}
      </p>

      {normalized.length === 0 ? (
        <EmptyState
          icon={<SearchIcon aria-hidden="true" />}
          title="Search Helix"
          body="Search mail, files, chat messages, events and people from the box above."
        />
      ) : null}

      {loading ? (
        <Skeleton variant="row" count={5} label="Searching" className="search-result-list" />
      ) : null}

      {!loading && failed ? (
        <InlineError
          className="search-result-list"
          message="Search is unavailable right now. Try again in a moment."
          retryLabel="Retry search"
          onRetry={() => {
            void invalidateGlobalSearch(queryClient, searchInput);
            void queryClient.invalidateQueries({ queryKey: ["people", "directory"] });
          }}
        />
      ) : null}

      {!loading && persons.length > 0 ? <PeopleResults people={persons} /> : null}

      {!loading && hits.length > 0 ? (
        <section aria-labelledby="search-content-heading">
          <h2 id="search-content-heading" className="search-section-title">
            {filter === undefined || filter === "people" ? "Results" : SEARCH_TYPE_LABELS[filter]}
          </h2>
          <ul className="search-result-list">
            {hits.map((hit) => (
              <li key={hit.id}>
                <SearchHitLink hit={hit} query={normalized} />
              </li>
            ))}
          </ul>
          {hits.length === pageSize && pageSize < PAGE_SIZES[1] ? (
            <Button
              type="button"
              variant="outline"
              className="search-more"
              onClick={() => setPageSize(PAGE_SIZES[1])}
            >
              Show more results
            </Button>
          ) : null}
        </section>
      ) : null}

      {!loading && !failed && normalized.length > 0 && hits.length === 0 && persons.length === 0 ? (
        <EmptyState
          icon={<SearchIcon aria-hidden="true" />}
          title={`No results for “${normalized}”`}
          body="Check the spelling, try fewer words, or pick another app above."
        />
      ) : null}
    </div>
  );
}

function SearchHitLink({ hit, query }: { readonly hit: GlobalSearchHit; readonly query: string }) {
  const Icon = TYPE_ICONS[hit.type];
  const detail = searchHitDetail(hit);
  const snippet = searchHitSnippet(hit, query);
  return (
    <Link {...searchHitTarget(hit)} className="search-result">
      <span className="search-result-icon" data-type={hit.type}>
        <Icon aria-hidden="true" size={16} />
      </span>
      <span className="search-result-text">
        <span className="search-result-title">{searchHitTitle(hit)}</span>
        <span className="search-result-detail">
          {SEARCH_TYPE_LABELS[hit.type]}
          {detail.length > 0 ? ` · ${detail}` : ""}
        </span>
        {snippet.length > 0 ? <span className="search-result-snippet">{snippet}</span> : null}
      </span>
    </Link>
  );
}

function PeopleResults({ people }: { readonly people: readonly PeopleDirectoryPerson[] }) {
  return (
    <section aria-labelledby="search-people-heading">
      <h2 id="search-people-heading" className="search-section-title">
        <Users aria-hidden="true" size={14} /> People
      </h2>
      <ul className="search-result-list">
        {people.map((person) => (
          <li key={person.id}>
            {person.email === null ? (
              <span className="search-result">
                <PersonSummary person={person} />
              </span>
            ) : (
              <Link
                to="/mail"
                search={{ compose: "new", to: person.email }}
                className="search-result"
                aria-label={`Email ${person.displayName}`}
              >
                <PersonSummary person={person} />
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PersonSummary({ person }: { readonly person: PeopleDirectoryPerson }) {
  return (
    <>
      <Avatar name={person.displayName} size={32} src={person.avatarDataUrl ?? undefined} />
      <span className="search-result-text">
        <span className="search-result-title">{person.displayName}</span>
        {person.email === null ? null : (
          <span className="search-result-detail">{person.email}</span>
        )}
      </span>
    </>
  );
}

function statusText({
  query,
  loading,
  failed,
  total,
}: {
  readonly query: string;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly total: number;
}): string {
  if (query.length === 0) return "";
  if (loading) return "Searching…";
  if (failed) return "Search could not load.";
  return `${new Intl.NumberFormat().format(total)} ${total === 1 ? "result" : "results"} for “${query}”`;
}
