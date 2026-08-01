import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { searchGlobal, type GlobalSearchInput } from "./api";

export const globalSearchQueryKeys = {
  query: (input: GlobalSearchInput) =>
    [
      "global-search",
      input.query.trim(),
      [...(input.types ?? [])].sort().join(","),
      input.limit ?? 10,
      input.offset ?? 0,
    ] as const,
};

export function globalSearchQueryOptions(input: GlobalSearchInput) {
  return queryOptions({
    queryKey: globalSearchQueryKeys.query(input),
    queryFn: () => searchGlobal(input),
    throwOnError: false,
    staleTime: 15_000,
  });
}

export function invalidateGlobalSearch(
  queryClient: QueryClient,
  input: GlobalSearchInput,
): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: globalSearchQueryKeys.query(input) });
}
