import { queryOptions } from "@tanstack/react-query";
import { sessionUserQueryOptions } from "@/lib/auth";
import {
  listDrive,
  listDriveAccess,
  listDriveWorkflows,
  getDriveUploadStatus,
  searchDrive,
  type DriveApiEntry,
  type DriveApiSearchHit,
} from "./api";
import { validateDriveRouteSearch, type DriveRouteSearch, type DriveScope } from "./route-search";

export { validateDriveRouteSearch };
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

const defaultDriveItemsInput = {
  folderId: null,
  includeTrashed: false,
  query: "",
  limit: 100,
  scope: "my",
} as const satisfies DriveItemsQueryInput;

export const driveQueryKeys = {
  access: (objectId: string) => ["drive", "access", objectId] as const,
  workflows: ["drive", "workflows"] as const,
  uploadStatus: (objectId: string | null) => ["drive", "upload-status", objectId] as const,
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

export function driveWorkflowsQueryOptions(enabled = true) {
  return queryOptions({
    queryKey: driveQueryKeys.workflows,
    queryFn: () => listDriveWorkflows(),
    enabled,
  });
}

export function driveUploadStatusQueryOptions(objectId: string | null) {
  return queryOptions({
    queryKey: driveQueryKeys.uploadStatus(objectId),
    queryFn: () => {
      if (objectId === null) throw new Error("No Drive upload is being processed.");
      return getDriveUploadStatus(objectId);
    },
    enabled: objectId !== null,
    refetchInterval: (query) => (query.state.data?.terminal === true ? false : 1_500),
    throwOnError: false,
  });
}

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
    folderId: scope === "my" || scope === "shared" ? (search.folder ?? null) : null,
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
    metadata: {},
    deletedAt: null,
    createdAt: hit.updatedAt,
    updatedAt: hit.updatedAt,
  };
}

/**
 * Apply Google Drive-style scope filters.
 *
 * My Drive is items you own. Shared with me is items others shared with you.
 * Opening a folder (owned or shared) shows every child you can access — the
 * same as Google: folder contents are not re-filtered by owner.
 */
export function applyDriveScope(
  entries: readonly DriveApiEntry[],
  scope: DriveScope,
  currentActorId: string | null,
  folderId?: string | null,
): readonly DriveApiEntry[] {
  if (scope === "trash") {
    return entries.filter((entry) => entry.deletedAt !== null);
  }

  const live = entries.filter((entry) => entry.deletedAt === null);
  const insideFolder = folderId !== undefined && folderId !== null && folderId.length > 0;

  switch (scope) {
    case "shared":
      if (insideFolder) return live;
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
      if (insideFolder) return live;
      return live.filter(
        (entry) =>
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
    ...sessionUserQueryOptions(),
    select: (user) => ({ actorId: user?.actorId ?? null, name: user?.name.trim() || "You" }),
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
            folderId: scope === "my" || scope === "shared" ? (input.folderId ?? null) : null,
            limit: input.limit ?? 50,
          }),
        };
      }

      // My Drive and Shared with me are folder trees. At the root they ask
      // for owned items vs share-roots; inside a folder they list children.
      // Recent / Starred stay flat cross-folder file views.
      if (scope === "my" || scope === "shared" || scope === "trash") {
        const folderId = input.folderId ?? null;
        return {
          mode: "list",
          entries: (
            await listDrive({
              folderId,
              includeTrashed: scope === "trash",
              limit: input.limit ?? 100,
              ...(scope === "trash" || folderId !== null
                ? {}
                : { view: scope === "my" ? "owned" : "shared" }),
            })
          ).entries,
        };
      }

      // Recordings are stored as `kind='recording'` objects, not files, so
      // drive.search won't find them — go straight to drive.list with the
      // kind filter so the user sees the meeting recordings they can play.
      if (scope === "recordings") {
        return {
          mode: "list",
          entries: (
            await listDrive({
              folderId: null,
              kind: "recording",
              limit: input.limit ?? 100,
            })
          ).entries,
        };
      }

      return {
        mode: "list",
        entries: (
          await listDrive({
            folderId: null,
            acrossFolders: true,
            limit: input.limit ?? 100,
          })
        ).entries,
      };
    },
    throwOnError: false,
  });
}
