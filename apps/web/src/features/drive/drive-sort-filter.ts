/* Drive sort and filter chips — pure helpers so the toolbar, the list and the
   tests agree on ordering. Folders always stay on top, like a long-time Drive
   user expects. */
import type { DriveFileType, DriveItem } from "./drive-data";

export type DriveSortKey = "name" | "modified" | "modified-by-me" | "opened-by-me" | "size";
export type DriveSortDirection = "asc" | "desc";

export interface DriveSort {
  readonly key: DriveSortKey;
  readonly direction: DriveSortDirection;
}

export const DRIVE_SORT_OPTIONS: ReadonlyArray<{
  readonly key: DriveSortKey;
  readonly label: string;
  /** Direction used when the key is first picked. */
  readonly defaultDirection: DriveSortDirection;
}> = [
  { key: "name", label: "Name", defaultDirection: "asc" },
  { key: "modified", label: "Last modified", defaultDirection: "desc" },
  { key: "modified-by-me", label: "Last modified by me", defaultDirection: "desc" },
  { key: "opened-by-me", label: "Last opened by me", defaultDirection: "desc" },
  { key: "size", label: "File size", defaultDirection: "desc" },
];

export const DEFAULT_DRIVE_SORT: DriveSort = { key: "name", direction: "asc" };

export function driveSortLabel(key: DriveSortKey): string {
  return DRIVE_SORT_OPTIONS.find((option) => option.key === key)?.label ?? "Name";
}

export interface DriveSortContext {
  readonly actorId: string | null;
  /** Item id → epoch ms the viewer last opened it in this browser. */
  readonly openedAt: ReadonlyMap<string, number>;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function time(iso: string): number {
  const value = new Date(iso).getTime();
  return Number.isNaN(value) ? 0 : value;
}

/** Sort value for the key; `null` sorts after every value in either direction. */
function sortValue(item: DriveItem, key: DriveSortKey, context: DriveSortContext): number | null {
  switch (key) {
    case "modified":
      return time(item.updatedAt);
    case "modified-by-me":
      // Only the owner's edits are known per item, so items you own carry
      // their modified time and everything else follows.
      return context.actorId !== null && item.ownerActorId === context.actorId
        ? time(item.updatedAt)
        : null;
    case "opened-by-me":
      return context.openedAt.get(item.id) ?? null;
    case "size":
      return item.byteSize;
    case "name":
      return null;
  }
}

function compareItems(
  a: DriveItem,
  b: DriveItem,
  sort: DriveSort,
  context: DriveSortContext,
): number {
  const byName = collator.compare(a.name, b.name);
  if (sort.key === "name") {
    return sort.direction === "asc" ? byName : -byName;
  }
  const left = sortValue(a, sort.key, context);
  const right = sortValue(b, sort.key, context);
  if (left === null && right === null) return byName;
  if (left === null) return 1;
  if (right === null) return -1;
  const delta = sort.direction === "asc" ? left - right : right - left;
  return delta === 0 ? byName : delta;
}

/** Folders first, then files, each ordered by the chosen sort. */
export function sortDriveItems(
  items: readonly DriveItem[],
  sort: DriveSort,
  context: DriveSortContext,
): DriveItem[] {
  return [...items].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return compareItems(a, b, sort, context);
  });
}

export type DriveTypeFilter = DriveFileType;

export const DRIVE_TYPE_FILTER_OPTIONS: ReadonlyArray<{
  readonly value: DriveTypeFilter;
  readonly label: string;
}> = [
  { value: "folder", label: "Folders" },
  { value: "doc", label: "Documents" },
  { value: "sheet", label: "Spreadsheets" },
  { value: "slides", label: "Presentations" },
  { value: "pdf", label: "PDFs" },
  { value: "image", label: "Photos and images" },
  { value: "video", label: "Videos" },
  { value: "audio", label: "Audio" },
  { value: "archive", label: "Archives" },
  { value: "code", label: "Code" },
  { value: "other", label: "Other files" },
];

export type DrivePeopleFilter =
  | { readonly kind: "me" }
  | { readonly kind: "not-me" }
  | { readonly kind: "owner"; readonly actorId: string; readonly label: string };

export type DriveModifiedFilter = "today" | "week" | "month" | "this-year" | "last-year";

export interface DriveFilters {
  readonly type: DriveTypeFilter | null;
  readonly people: DrivePeopleFilter | null;
  readonly modified: DriveModifiedFilter | null;
}

export const NO_DRIVE_FILTERS: DriveFilters = { type: null, people: null, modified: null };

export function hasDriveFilters(filters: DriveFilters): boolean {
  return filters.type !== null || filters.people !== null || filters.modified !== null;
}

export function driveModifiedOptions(
  now: Date = new Date(),
): ReadonlyArray<{ readonly value: DriveModifiedFilter; readonly label: string }> {
  const year = now.getFullYear();
  return [
    { value: "today", label: "Today" },
    { value: "week", label: "Last 7 days" },
    { value: "month", label: "Last 30 days" },
    { value: "this-year", label: `This year (${String(year)})` },
    { value: "last-year", label: `Last year (${String(year - 1)})` },
  ];
}

function modifiedRange(filter: DriveModifiedFilter, now: Date): readonly [number, number] {
  const day = 86_400_000;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  switch (filter) {
    case "today":
      return [startOfToday, Number.POSITIVE_INFINITY];
    case "week":
      return [now.getTime() - 7 * day, Number.POSITIVE_INFINITY];
    case "month":
      return [now.getTime() - 30 * day, Number.POSITIVE_INFINITY];
    case "this-year":
      return [new Date(now.getFullYear(), 0, 1).getTime(), Number.POSITIVE_INFINITY];
    case "last-year":
      return [
        new Date(now.getFullYear() - 1, 0, 1).getTime(),
        new Date(now.getFullYear(), 0, 1).getTime(),
      ];
  }
}

function matchesPeople(
  item: DriveItem,
  filter: DrivePeopleFilter,
  actorId: string | null,
): boolean {
  const mine = actorId !== null && item.ownerActorId === actorId;
  switch (filter.kind) {
    case "me":
      return mine;
    case "not-me":
      return !mine;
    case "owner":
      return item.ownerActorId === filter.actorId;
  }
}

export function filterDriveItems(
  items: readonly DriveItem[],
  filters: DriveFilters,
  context: { readonly actorId: string | null; readonly now?: Date },
): DriveItem[] {
  const now = context.now ?? new Date();
  const range = filters.modified === null ? null : modifiedRange(filters.modified, now);
  return items.filter((item) => {
    if (filters.type !== null && item.type !== filters.type) return false;
    if (filters.people !== null && !matchesPeople(item, filters.people, context.actorId)) {
      return false;
    }
    if (range !== null) {
      const modified = time(item.updatedAt);
      if (modified < range[0] || modified >= range[1]) return false;
    }
    return true;
  });
}

/** Owners other than the viewer, for the People chip, ordered by name. */
export function drivePeopleOptions(
  items: readonly DriveItem[],
  actorId: string | null,
): ReadonlyArray<{ readonly actorId: string; readonly label: string }> {
  const owners = new Map<string, string>();
  for (const item of items) {
    if (item.ownerActorId === null || item.ownerActorId === actorId) continue;
    owners.set(item.ownerActorId, item.owner);
  }
  return [...owners]
    .map(([id, label]) => ({ actorId: id, label }))
    .sort((a, b) => collator.compare(a.label, b.label));
}

export function drivePeopleFilterLabel(filter: DrivePeopleFilter): string {
  switch (filter.kind) {
    case "me":
      return "Owned by me";
    case "not-me":
      return "Not owned by me";
    case "owner":
      return filter.label;
  }
}
