import { optionalEnumSearchParam, optionalStringSearchParam } from "@/lib/search-params";
import { globalSearchTypes, type GlobalSearchType } from "./api";

/** Result filters on `/search`: an indexed app, or the people directory. */
export type SearchFilter = GlobalSearchType | "people";

const searchFilters: readonly SearchFilter[] = [...globalSearchTypes, "people"];

/** `/search?q=<query>&type=<filter>` */
export interface SearchRouteSearch {
  readonly q?: string;
  readonly type?: SearchFilter;
}

export function validateSearchRouteSearch(search: Record<string, unknown>): SearchRouteSearch {
  const q = optionalStringSearchParam(search.q);
  const type = optionalEnumSearchParam(search.type, searchFilters);
  return {
    ...(q === undefined ? {} : { q }),
    ...(type === undefined ? {} : { type }),
  };
}

/** The search filter that matches an app id, when that app's content is indexed. */
export function searchFilterForApp(appId: string | undefined): GlobalSearchType | undefined {
  return globalSearchTypes.find((type) => type === appId);
}
