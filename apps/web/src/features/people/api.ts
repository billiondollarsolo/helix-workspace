import { useDebouncedValue } from "@tanstack/react-pacer/debouncer";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/auth";

export type PeopleApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** One row of the actor's people directory: personal contacts, org members and groups. */
export interface PeopleDirectoryPerson {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string;
  readonly kind: "personal" | "directory" | "group";
  /** The org member this entry resolves to; personal contacts inherit it by email. */
  readonly actorId: string | null;
  readonly title: string | null;
  readonly favorite: boolean;
  readonly avatarDataUrl: string | null;
  readonly relationship: Readonly<Record<string, string>>;
}

interface PeopleDirectoryListResponse {
  readonly people: readonly PeopleDirectoryPerson[];
}

export interface PeopleDirectoryListInput {
  readonly limit?: number;
  readonly query?: string;
}

const PEOPLE_SEARCH_LIMIT = 12;
const PEOPLE_SEARCH_DEBOUNCE_MS = 150;

export function peopleDirectoryQueryOptions(input: PeopleDirectoryListInput = {}) {
  return {
    queryKey: ["people", "directory", input] as const,
    queryFn: () => listPeopleDirectory(input),
    staleTime: 30_000,
  };
}

export async function listPeopleDirectory(
  input: PeopleDirectoryListInput = {},
  fetchImpl: PeopleApiFetch = authenticatedFetch,
): Promise<readonly PeopleDirectoryPerson[]> {
  const params = new URLSearchParams();
  params.set("limit", String(input.limit ?? 25));
  const query = input.query?.trim();
  if (query !== undefined && query.length > 0) {
    params.set("query", query);
  }
  return readPeople(await fetchImpl(`/api/people?${params.toString()}`));
}

export function peopleSearchQueryOptions(query: string) {
  return {
    queryKey: ["people", "search", query] as const,
    queryFn: () => searchPeople(query),
    enabled: query.length > 0,
    staleTime: 5 * 60_000,
  };
}

/**
 * Typeahead search over the actor's tenant directory. The server scopes every
 * row to the signed-in actor's org and drops entries without an address.
 */
async function searchPeople(
  query: string,
  fetchImpl: PeopleApiFetch = authenticatedFetch,
): Promise<readonly PeopleDirectoryPerson[]> {
  const params = new URLSearchParams({ query, limit: String(PEOPLE_SEARCH_LIMIT) });
  return readPeople(await fetchImpl(`/api/people/autocomplete?${params.toString()}`));
}

/** Debounced, per-query cached people search for pickers. Empty input never fetches. */
export function usePeopleSearch(query: string) {
  const [debouncedQuery] = useDebouncedValue(query.trim().toLowerCase(), {
    wait: PEOPLE_SEARCH_DEBOUNCE_MS,
  });
  const result = useQuery({
    ...peopleSearchQueryOptions(debouncedQuery),
    placeholderData: keepPreviousData,
  });
  return {
    people: debouncedQuery.length > 0 ? (result.data ?? []) : [],
    loading: debouncedQuery.length > 0 && result.isFetching,
    error: result.isError,
  };
}

async function readPeople(response: Response): Promise<readonly PeopleDirectoryPerson[]> {
  const output: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      errorMessageFromOutput(output) ?? `People directory failed with ${String(response.status)}`,
    );
  }
  if (!isPeopleDirectoryListResponse(output)) {
    throw new Error("People directory response was missing required fields.");
  }
  return output.people.map(normalizePerson);
}

function isPeopleDirectoryListResponse(value: unknown): value is PeopleDirectoryListResponse {
  return (
    isRecord(value) && Array.isArray(value.people) && value.people.every(isPeopleDirectoryPerson)
  );
}

function isPeopleDirectoryPerson(value: unknown): value is PeopleDirectoryPerson {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (typeof value.email === "string" || value.email === null) &&
    typeof value.displayName === "string"
  );
}

function normalizePerson(value: PeopleDirectoryPerson): PeopleDirectoryPerson {
  return {
    id: value.id,
    email: value.email,
    displayName: value.displayName,
    kind: value.kind === "personal" || value.kind === "group" ? value.kind : "directory",
    actorId: optionalString(value.actorId) ?? (value.kind === "directory" ? value.id : null),
    title: optionalString(value.title),
    favorite: value.favorite === true,
    avatarDataUrl: optionalString(value.avatarDataUrl),
    relationship: isStringRecord(value.relationship) ? value.relationship : {},
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function errorMessageFromOutput(output: unknown): string | undefined {
  return isRecord(output) && typeof output.error === "string" ? output.error : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
