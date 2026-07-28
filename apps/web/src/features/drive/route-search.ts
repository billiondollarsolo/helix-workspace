import {
  optionalBooleanSearchParam,
  optionalEnumSearchParam,
  optionalStringSearchParam,
} from "@/lib/search-params";

export const DRIVE_SCOPE_IDS = [
  "my",
  "shared",
  "recent",
  "starred",
  "recordings",
  "trash",
] as const;
export type DriveScope = (typeof DRIVE_SCOPE_IDS)[number];

export interface DriveRouteSearch {
  readonly file?: string;
  readonly folder?: string;
  readonly includeTrashed?: boolean;
  readonly q?: string;
  readonly scope?: DriveScope;
}

export function validateDriveRouteSearch(search: Record<string, unknown>): DriveRouteSearch {
  const folder = optionalStringSearchParam(search.folder);
  const includeTrashed = optionalBooleanSearchParam(search.includeTrashed);

  return {
    file: optionalStringSearchParam(search.file) ?? optionalStringSearchParam(search.id),
    folder: folder === "root" ? undefined : folder,
    includeTrashed,
    q: optionalStringSearchParam(search.q),
    scope:
      includeTrashed === undefined
        ? optionalEnumSearchParam(search.scope, DRIVE_SCOPE_IDS)
        : undefined,
  };
}
