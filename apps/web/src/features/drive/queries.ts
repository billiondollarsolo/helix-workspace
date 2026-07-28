import { queryOptions } from "@tanstack/react-query";
import { getSessionUser } from "@/lib/auth";
import {
  listDrive,
  listDriveAccess,
  searchDrive,
  type DriveApiEntry,
  type DriveApiSearchHit,
} from "./api";
import {
  DRIVE_SCOPE_IDS,
  validateDriveRouteSearch,
  type DriveRouteSearch,
  type DriveScope,
} from "./route-search";

export { DRIVE_SCOPE_IDS, validateDriveRouteSearch };
export type { DriveRouteSearch, DriveScope };

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
export function fallbackDriveSuggestions(entries: readonly DriveApiEntry[]): DriveSuggestions {
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
  readonly scope?: DriveScope;
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
  scope: "my",
} as const satisfies DriveItemsQueryInput;

export const driveQueryKeys = {
  access: (objectId: string) => ["drive", "access", objectId] as const,
  items: (input: DriveItemsQueryInput = defaultDriveItemsInput) =>
    [
      "drive",
      "items",
      input.scope ?? "my",
      input.folderId ?? "root",
      input.includeTrashed ?? false,
      input.query?.trim() ?? "",
      input.limit ?? 100,
    ] as const,
  all: ["drive"] as const,
};

export function driveAccessQueryOptions(objectId: string, enabled = true) {
  return queryOptions({
    queryKey: driveQueryKeys.access(objectId),
    queryFn: () => listDriveAccess(objectId),
    enabled,
    throwOnError: false,
  });
}

export function driveItemsInputFromRouteSearch(search: DriveRouteSearch): DriveItemsQueryInput {
  const query = search.q?.trim() ?? "";
  const scope: DriveScope =
    search.includeTrashed === true || search.scope === "trash" ? "trash" : (search.scope ?? "my");
  return {
    folderId: scope === "my" ? (search.folder ?? null) : null,
    includeTrashed: scope === "trash",
    query,
    limit: query.length > 0 ? 50 : 100,
    scope,
  };
}

/** A search hit promoted into an entry-shaped record for unified rendering. */
export function entryFromSearchHit(hit: DriveApiSearchHit): DriveApiEntry {
  return {
    id: hit.objectId,
    type: "file",
    name: hit.name,
    folderId: hit.folderId,
    ownerActorId: null,
    mimeType: hit.mimeType,
    byteSize: hit.byteSize,
    sha256: hit.sha256,
    ...(hit.previewMetadata === undefined ? {} : { preview: hit.previewMetadata }),
    metadata: {},
    deletedAt: null,
    createdAt: hit.updatedAt,
    updatedAt: hit.updatedAt,
  };
}

/**
 * Apply scope-specific client-side filtering to a Drive entry list.
 *
 *  - `my`      — entries in the active folder (already folder-scoped upstream).
 *  - `shared`  — entries owned by someone other than the current actor.
 *  - `recent`  — every entry, sorted by most-recent activity (cap 50).
 *  - `starred` — entries flagged via `metadata.starred`.
 *  - `trash`   — trashed entries.
 */
export function applyDriveScope(
  entries: readonly DriveApiEntry[],
  scope: DriveScope,
  currentActorId: string | null,
): readonly DriveApiEntry[] {
  if (scope === "trash") {
    return entries.filter((entry) => entry.deletedAt !== null);
  }

  const live = entries.filter((entry) => entry.deletedAt === null);

  switch (scope) {
    case "shared":
      return live.filter(
        (entry) =>
          currentActorId !== null &&
          entry.ownerActorId !== null &&
          entry.ownerActorId !== currentActorId,
      );
    case "starred":
      return live.filter((entry) => entry.metadata?.starred === true);
    case "recent":
      return [...live]
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, 50);
    case "my":
      // "My Drive" should mean files I own — not "everything I have any
      // visibility on". Files I only have a viewer/editor grant on
      // belong under "Shared with me". Folders are always included
      // since they're the navigation scaffolding for the current view.
      return live.filter(
        (entry) =>
          entry.type === "folder" ||
          currentActorId === null ||
          entry.ownerActorId === null ||
          entry.ownerActorId === currentActorId,
      );
    default:
      return live;
  }
}

/** Query for the current session actor id — used for scope filtering + owner labels. */
export function driveActorQueryOptions() {
  return queryOptions({
    queryKey: ["drive", "actor"],
    queryFn: async (): Promise<{ readonly actorId: string | null; readonly name: string }> => {
      const user = await getSessionUser();
      return { actorId: user?.actorId ?? null, name: user?.name ?? "You" };
    },
    staleTime: 5 * 60_000,
    throwOnError: false,
  });
}

export function driveItemsQueryOptions(input: DriveItemsQueryInput = defaultDriveItemsInput) {
  const normalizedQuery = input.query?.trim() ?? "";
  const scope: DriveScope = input.scope ?? "my";
  return queryOptions({
    queryKey: driveQueryKeys.items({ ...input, scope }),
    queryFn: async (): Promise<DriveItemsQueryResult> => {
      if (normalizedQuery.length > 0) {
        return {
          mode: "search",
          hits: await searchDrive({
            query: normalizedQuery,
            folderId: scope === "my" ? (input.folderId ?? null) : null,
            limit: input.limit ?? 50,
          }),
        };
      }

      // `my` + `trash` are folder-scoped views — `drive.list` returns the
      // folders and files of the active folder. The other scopes (Recent /
      // Shared / Starred) are cross-folder file views, so they ride
      // `drive.list` with `acrossFolders` and keep full owner/app/metadata for
      // client-side scope filtering.
      if (scope === "my" || scope === "trash") {
        return {
          mode: "list",
          entries: await listDrive({
            folderId: input.folderId ?? null,
            includeTrashed: scope === "trash",
            limit: input.limit ?? 100,
          }),
        };
      }

      // Recordings are stored as `kind='recording'` objects, not files, so
      // drive.search won't find them — go straight to drive.list with the
      // kind filter so the user sees the meeting recordings they can play.
      if (scope === "recordings") {
        return {
          mode: "list",
          entries: await listDrive({
            folderId: null,
            kind: "recording",
            limit: input.limit ?? 100,
          }),
        };
      }

      return {
        mode: "list",
        entries: await listDrive({
          folderId: null,
          acrossFolders: true,
          limit: input.limit ?? 100,
        }),
      };
    },
    throwOnError: false,
  });
}
