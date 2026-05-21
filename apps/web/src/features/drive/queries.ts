import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { listDrive, searchDrive, type DriveApiEntry, type DriveApiSearchHit } from "./api";

export interface DriveSuggestions {
  readonly folders: readonly DriveApiEntry[];
  readonly files: readonly DriveApiEntry[];
}

export function deriveDriveSuggestions(entries: readonly DriveApiEntry[]): DriveSuggestions {
  const sorted = [...entries]
    .filter((entry) => entry.deletedAt === null)
    .sort((a, b) => {
      const aTime = new Date(a.updatedAt).getTime();
      const bTime = new Date(b.updatedAt).getTime();
      return bTime - aTime;
    });

  const folders = sorted.filter((entry) => entry.type === "folder").slice(0, 5);
  const files = sorted.filter((entry) => entry.type === "file").slice(0, 10);

  return { folders, files };
}

/**
 * Build Drive suggestions from a local set of folder/file entries. Used when
 * the backend suggestions query is unavailable (offline) so the Suggested
 * folders / Suggested files sections still render real content.
 */
export function fallbackDriveSuggestions(
  entries: readonly DriveApiEntry[],
): DriveSuggestions {
  return deriveDriveSuggestions(entries);
}

export function driveSuggestionsQueryOptions() {
  return queryOptions({
    queryKey: ["drive", "suggestions"],
    queryFn: async (): Promise<DriveSuggestions> => {
      const entries = await listDrive({ folderId: null, limit: 100 });
      return deriveDriveSuggestions(entries);
    },
    throwOnError: false,
  });
}

export interface DriveItemsQueryInput {
  readonly folderId?: string | null;
  readonly includeTrashed?: boolean;
  readonly query?: string;
  readonly limit?: number;
}

export interface DriveRouteSearch {
  readonly file?: string;
  readonly folder?: string;
  readonly includeTrashed?: boolean;
  readonly q?: string;
  readonly scope?: "documents" | "sheets" | "slides" | "shared" | "trash";
}

export type DriveItemsQueryResult =
  | {
      readonly mode: "list";
      readonly entries: readonly DriveApiEntry[];
    }
  | {
      readonly mode: "search";
      readonly hits: readonly DriveApiSearchHit[];
    };

export const defaultDriveItemsInput = {
  folderId: null,
  includeTrashed: false,
  query: "",
  limit: 100,
} as const satisfies DriveItemsQueryInput;

export const driveQueryKeys = {
  items: (input: DriveItemsQueryInput = defaultDriveItemsInput) =>
    [
      "drive",
      "items",
      input.folderId ?? "root",
      input.includeTrashed ?? false,
      input.query?.trim() ?? "",
      input.limit ?? 100,
    ] as const,
};

const nonEmptyStringParam = z.string().trim().min(1).optional().catch(undefined);

const driveRouteSearchSchema = z
  .object({
    file: nonEmptyStringParam,
    folder: nonEmptyStringParam,
    id: nonEmptyStringParam,
    includeTrashed: z
      .union([z.literal(true), z.literal("true"), z.literal("1")])
      .optional()
      .catch(undefined),
    q: nonEmptyStringParam,
    scope: z.enum(["documents", "sheets", "slides", "shared", "trash"]).optional().catch(undefined),
  })
  .catch({});

export function validateDriveRouteSearch(search: Record<string, unknown>): DriveRouteSearch {
  const parsed = driveRouteSearchSchema.parse(search);
  const folder = parsed.folder;

  return {
    file: parsed.file ?? parsed.id,
    folder: folder === "root" ? undefined : folder,
    includeTrashed: parsed.includeTrashed === undefined ? undefined : true,
    q: parsed.q,
    scope: parsed.includeTrashed === undefined ? parsed.scope : undefined,
  };
}

export function driveItemsInputFromRouteSearch(search: DriveRouteSearch): DriveItemsQueryInput {
  const query = search.q?.trim() ?? "";
  return {
    folderId: search.includeTrashed === true ? null : (search.folder ?? null),
    includeTrashed: search.includeTrashed === true,
    query,
    limit: query.length > 0 ? 50 : 100,
  };
}

export function driveItemsQueryOptions(input: DriveItemsQueryInput = defaultDriveItemsInput) {
  const normalizedQuery = input.query?.trim() ?? "";
  return queryOptions({
    queryKey: driveQueryKeys.items(input),
    queryFn: async (): Promise<DriveItemsQueryResult> => {
      if (normalizedQuery.length > 0) {
        return {
          mode: "search",
          hits: await searchDrive({
            query: normalizedQuery,
            folderId: input.folderId ?? null,
            limit: input.limit ?? 50,
          }),
        };
      }

      return {
        mode: "list",
        entries: await listDrive({
          folderId: input.folderId ?? null,
          includeTrashed: input.includeTrashed ?? false,
          limit: input.limit ?? 100,
        }),
      };
    },
    throwOnError: false,
  });
}
