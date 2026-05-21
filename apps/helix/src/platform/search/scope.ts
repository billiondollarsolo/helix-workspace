import type { Actor } from "@helix/sdk-types";
import type { SearchRequest } from "./types.js";

export const globalSearchTypes = ["mail", "chat", "docs", "drive", "calendar"] as const;

export type GlobalSearchType = (typeof globalSearchTypes)[number];

const readScopeByType: Record<GlobalSearchType, string> = {
  mail: "mail.read",
  chat: "chat.read",
  docs: "docs.read",
  drive: "drive.read",
  calendar: "calendar.read",
};

export interface ScopedSearchInput {
  readonly query: string;
  readonly types?: readonly GlobalSearchType[] | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  readonly filter?: string | readonly string[] | undefined;
  readonly attributesToRetrieve?: readonly string[] | undefined;
}

export function allowedSearchTypesForActor(actor: Actor): readonly GlobalSearchType[] {
  if (actor.type === "system") {
    return globalSearchTypes;
  }

  const scopes = new Set(actor.scopes ?? []);
  return globalSearchTypes.filter((type) => scopes.has(readScopeByType[type]));
}

export function createScopedSearchRequest(
  actor: Actor,
  input: ScopedSearchInput,
): SearchRequest | undefined {
  const allowedTypes = allowedSearchTypesForActor(actor);
  const selectedTypes =
    input.types === undefined || input.types.length === 0
      ? allowedTypes
      : input.types.filter((type) => allowedTypes.includes(type));

  if (selectedTypes.length === 0) {
    return undefined;
  }

  const filter = combineSearchFilters(
    actor.type === "system" ? undefined : `attributes.orgId = ${JSON.stringify(actor.orgId)}`,
    input.filter,
  );

  return {
    query: input.query,
    types: selectedTypes,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.offset === undefined ? {} : { offset: input.offset }),
    ...(input.attributesToRetrieve === undefined
      ? {}
      : { attributesToRetrieve: input.attributesToRetrieve }),
    ...(filter === undefined ? {} : { filter }),
  };
}

function combineSearchFilters(
  requiredFilter: string | undefined,
  extraFilter: string | readonly string[] | undefined,
): string | readonly string[] | undefined {
  if (requiredFilter === undefined) {
    return extraFilter;
  }
  if (extraFilter === undefined) {
    return requiredFilter;
  }
  if (typeof extraFilter === "string") {
    return [requiredFilter, extraFilter];
  }
  return [requiredFilter, ...extraFilter];
}
