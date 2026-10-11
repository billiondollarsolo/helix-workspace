/* Drive view model: one `DriveItem` shape for files and folders, the type
   categories behind the type icons, and formatting helpers. Everything maps
   from the backend `DriveApiEntry`; no seed data lives here. */
import type { DriveUploadState } from "@helix/contracts";
import type { DriveApiEntry } from "./api";
import { canOpenDriveObject, driveUploadStatusView } from "./upload-status-ui";

/** A file's category, shown as a colored type icon. Drive never previews content. */
export type DriveFileType =
  | "folder"
  | "image"
  | "pdf"
  | "doc"
  | "sheet"
  | "slides"
  | "audio"
  | "video"
  | "archive"
  | "code"
  | "other";

/** A file or folder row/card. */
export interface DriveItem {
  readonly id: string;
  readonly kind: "file" | "folder";
  readonly name: string;
  readonly type: DriveFileType;
  readonly folderId: string | null;
  readonly ownerActorId: string | null;
  /** Owner display label ("Ada Park"); the shell swaps in "me" for the viewer. */
  readonly owner: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly byteSize: number | null;
  readonly mimeType: string | null;
  readonly starred: boolean;
  readonly deletedAt: string | null;
  /** When a trashed item can be deleted forever (end of its recovery window). */
  readonly trashPurgeAfter: string | null;
  /** Upload/scan lifecycle. Absent on folders. */
  readonly uploadState: DriveUploadState | null;
  readonly uploadStatusLabel: string | null;
  /** Folders are always available; files only once their scan is clean. */
  readonly available: boolean;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Format a byte size into a short label, e.g. "184 KB". */
export function formatByteSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || bytes <= 0) {
    return "—";
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${String(rounded)} ${BYTE_UNITS[unit]}`;
}

/** Short "last modified" label: "5 min ago", "Yesterday", "Mar 4". */
export function formatModified(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "—";
  }
  const diffMs = now - then;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < hour) {
    const mins = Math.max(1, Math.round(diffMs / minute));
    return `${String(mins)} min ago`;
  }
  if (diffMs < day) {
    const hours = Math.max(1, Math.round(diffMs / hour));
    return `${String(hours)} hour${hours === 1 ? "" : "s"} ago`;
  }
  if (diffMs < 2 * day) {
    return "Yesterday";
  }
  const sameYear = new Date(then).getFullYear() === new Date(now).getFullYear();
  return new Date(then).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Full date and time for the details panel, e.g. "Mar 4, 2026, 9:12 AM". */
export function formatDateTime(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return "—";
  return time.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const TYPE_BY_EXTENSION: Readonly<Record<string, DriveFileType>> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  heic: "image",
  bmp: "image",
  tif: "image",
  tiff: "image",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  flac: "audio",
  ogg: "audio",
  aac: "audio",
  mp4: "video",
  mov: "video",
  m4v: "video",
  avi: "video",
  mkv: "video",
  webm: "video",
  pdf: "pdf",
  doc: "doc",
  docx: "doc",
  odt: "doc",
  rtf: "doc",
  txt: "doc",
  md: "doc",
  pages: "doc",
  xls: "sheet",
  xlsx: "sheet",
  ods: "sheet",
  csv: "sheet",
  tsv: "sheet",
  numbers: "sheet",
  ppt: "slides",
  pptx: "slides",
  odp: "slides",
  key: "slides",
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  bz2: "archive",
  xz: "archive",
  js: "code",
  jsx: "code",
  ts: "code",
  tsx: "code",
  json: "code",
  html: "code",
  css: "code",
  py: "code",
  rb: "code",
  go: "code",
  rs: "code",
  java: "code",
  c: "code",
  h: "code",
  cpp: "code",
  cs: "code",
  sh: "code",
  sql: "code",
  yaml: "code",
  yml: "code",
  xml: "code",
  toml: "code",
};

const TYPE_BY_MIME: ReadonlyArray<readonly [RegExp, DriveFileType]> = [
  [/^image\//u, "image"],
  [/^audio\//u, "audio"],
  [/^video\//u, "video"],
  [/^application\/pdf$/u, "pdf"],
  [/spreadsheet|excel|csv/u, "sheet"],
  [/presentation|powerpoint/u, "slides"],
  [/wordprocessing|msword|opendocument\.text|^text\/(plain|markdown|rtf)/u, "doc"],
  [/zip|compressed|x-tar|gzip|x-7z|x-rar|x-bzip/u, "archive"],
  [/json|javascript|typescript|x-python|x-sh|xml|yaml|^text\/(html|css|x-)/u, "code"],
];

/** Infer the type icon category from a file's name and MIME type. */
export function fileTypeFromName(name: string, mimeType: string | null | undefined): DriveFileType {
  const mime = mimeType?.toLowerCase() ?? "";
  for (const [pattern, type] of TYPE_BY_MIME) {
    if (pattern.test(mime)) return type;
  }
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  return TYPE_BY_EXTENSION[extension] ?? "other";
}

function ownerLabelFromEntry(entry: DriveApiEntry): string {
  return (
    entry.ownerDisplayName?.trim() ||
    entry.ownerEmail?.trim() ||
    entry.ownerActorId?.trim() ||
    "Unknown owner"
  );
}

/** Adapt a backend entry (file or folder) into the shared row/card model. */
export function driveItemFromEntry(entry: DriveApiEntry): DriveItem {
  const folder = entry.type === "folder";
  const uploadState = folder ? null : (entry.uploadState ?? null);
  const status = driveUploadStatusView(uploadState);
  return {
    id: entry.id,
    kind: folder ? "folder" : "file",
    name: entry.name,
    type: folder ? "folder" : fileTypeFromName(entry.name, entry.mimeType),
    folderId: entry.folderId,
    ownerActorId: entry.ownerActorId,
    owner: ownerLabelFromEntry(entry),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    byteSize: folder ? null : (entry.byteSize ?? null),
    mimeType: folder ? null : (entry.mimeType ?? null),
    starred: entry.metadata.starred === true,
    deletedAt: entry.deletedAt,
    trashPurgeAfter: entry.trashPurgeAfter ?? null,
    uploadState,
    uploadStatusLabel: entry.uploadStatusLabel ?? status?.label ?? null,
    available:
      folder || (entry.available ?? canOpenDriveObject({ uploadState: entry.uploadState })),
  };
}

/** Trashed items can be deleted forever once their recovery window ends. */
export function canDeleteForever(item: Pick<DriveItem, "trashPurgeAfter">, now = Date.now()) {
  return item.trashPurgeAfter !== null && new Date(item.trashPurgeAfter).getTime() <= now;
}

/** Whole days between trashing and permanent deletion, read from the server deadlines. */
export function trashRetentionDays(items: readonly DriveItem[]): number | null {
  for (const item of items) {
    if (item.deletedAt === null || item.trashPurgeAfter === null) continue;
    const days = Math.round(
      (new Date(item.trashPurgeAfter).getTime() - new Date(item.deletedAt).getTime()) / 86_400_000,
    );
    if (Number.isFinite(days) && days > 0) return days;
  }
  return null;
}
