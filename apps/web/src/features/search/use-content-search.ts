/* Type-ahead content search for the command palette: indexed mail, files,
   chat messages and events from `search.query`, plus matching people from the
   directory. Debounced, and idle below two characters. */

import { useDebouncedValue } from "@tanstack/react-pacer/debouncer";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { peopleDirectoryQueryOptions, type PeopleDirectoryPerson } from "@/features/people/api";
import type { GlobalSearchHit, GlobalSearchType } from "./api";
import { globalSearchQueryOptions } from "./queries";
import { SEARCH_TYPE_ORDER } from "./search-hits";

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 200;
const HITS_PER_TYPE = 4;
const PEOPLE_LIMIT = 4;

export interface ContentSearchState {
  /** The debounced query the results belong to; empty while idle. */
  readonly query: string;
  readonly hitsByType: readonly {
    readonly type: GlobalSearchType;
    readonly hits: readonly GlobalSearchHit[];
  }[];
  readonly people: readonly PeopleDirectoryPerson[];
  readonly loading: boolean;
  readonly failed: boolean;
}

export function useContentSearch(query: string, enabled: boolean): ContentSearchState {
  const [debounced] = useDebouncedValue(query.trim(), { wait: DEBOUNCE_MS });
  const active = enabled && debounced.length >= MIN_QUERY_LENGTH;
  const content = useQuery({
    ...globalSearchQueryOptions({ query: debounced, limit: 20 }),
    enabled: active,
  });
  const people = useQuery({
    ...peopleDirectoryQueryOptions({ query: debounced, limit: PEOPLE_LIMIT }),
    enabled: active,
  });

  const hits = content.data?.hits;
  const persons = people.data;
  const loading = content.isLoading || people.isLoading;
  const failed = content.isError;
  // Stable identity between renders, so the palette keeps its active option.
  return useMemo(() => {
    if (!active) {
      return IDLE;
    }
    return {
      query: debounced,
      hitsByType: SEARCH_TYPE_ORDER.map((type) => ({
        type,
        hits: (hits ?? []).filter((hit) => hit.type === type).slice(0, HITS_PER_TYPE),
      })).filter((group) => group.hits.length > 0),
      people: (persons ?? []).slice(0, PEOPLE_LIMIT),
      loading,
      failed,
    };
  }, [active, debounced, hits, persons, loading, failed]);
}

const IDLE: ContentSearchState = {
  query: "",
  hitsByType: [],
  people: [],
  loading: false,
  failed: false,
};
