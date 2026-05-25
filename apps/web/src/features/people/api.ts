import { authenticatedFetch } from "@/lib/auth";

export type PeopleApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface PeopleDirectoryPerson {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string;
}

export interface PeopleDirectoryListResponse {
  readonly people: readonly PeopleDirectoryPerson[];
}

export interface PeopleDirectoryListInput {
  readonly limit?: number;
  readonly query?: string;
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

  const response = await fetchImpl(`/api/people?${params.toString()}`);
  const output: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      errorMessageFromOutput(output) ?? `People directory failed with ${response.status}`,
    );
  }
  if (!isPeopleDirectoryListResponse(output)) {
    throw new Error("People directory response was missing required fields.");
  }
  return output.people;
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

function errorMessageFromOutput(output: unknown): string | undefined {
  return isRecord(output) && typeof output.error === "string" ? output.error : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
