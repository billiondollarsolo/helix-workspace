import { createFileRoute } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import type { GlobalSearchType } from "@/features/search/api";
import { globalSearchQueryOptions } from "@/features/search/queries";

export interface SearchRouteSearch {
  readonly q?: string;
  readonly types?: readonly GlobalSearchType[];
}

const searchTypeSchema = z.enum(["mail", "chat", "docs", "drive", "calendar"]);
const searchRouteSearchSchema = z
  .object({
    q: z.string().trim().min(1).optional().catch(undefined),
    type: z.unknown().optional().catch(undefined),
    types: z.unknown().optional().catch(undefined),
  })
  .catch({});

export const Route = createFileRoute("/_shell/search/")({
  validateSearch: validateSearchRouteSearch,
  loaderDeps: ({ search }) => ({
    q: search.q,
    types: search.types,
  }),
  loader: async ({ context, deps }) => {
    await preloadSearchRouteData(context.queryClient, deps);
  },
});

export function validateSearchRouteSearch(search: Record<string, unknown>): SearchRouteSearch {
  const parsed = searchRouteSearchSchema.parse(search);
  const types = parseSearchTypes(parsed.types ?? parsed.type);
  return {
    ...(parsed.q === undefined ? {} : { q: parsed.q }),
    ...(types.length === 0 ? {} : { types }),
  };
}

export async function preloadSearchRouteData(
  queryClient: QueryClient,
  deps: SearchRouteSearch,
): Promise<void> {
  const query = deps.q?.trim() ?? "";
  if (query.length === 0) {
    return;
  }

  await queryClient
    .ensureQueryData(globalSearchQueryOptions({ query, types: deps.types, limit: 100 }))
    .catch(() => undefined);
}

function parseSearchTypes(value: unknown): readonly GlobalSearchType[] {
  const values =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value.flatMap((item) => (typeof item === "string" ? item.split(",") : []))
        : [];
  const uniqueTypes = new Set<GlobalSearchType>();
  for (const item of values) {
    const result = searchTypeSchema.safeParse(item.trim());
    if (result.success) {
      uniqueTypes.add(result.data);
    }
  }
  return [...uniqueTypes];
}
