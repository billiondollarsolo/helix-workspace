/* Drive — view-model types, file-type icon metadata, and mapping helpers
   from the backend `DriveApiEntry` shape onto the rows the shell renders.
   No fabricated seed data lives here. */

import type { DriveApiEntry, DriveApiPreview } from "./api";
import { driveEntrySurface } from "./format-surface";

/** A file's visual category — drives the type-colored icon. */
export type DriveFileType = "doc" | "sheet" | "slides" | "pdf" | "design" | "video" | "folder";

/** A folder tile in the Folders section. */
export interface DriveFolderItem {
  readonly id: string;
  readonly name: string;
  readonly itemCount: number;
}

/** A file card / row in the Files section. */
export interface DriveFileItem {
  readonly id: string;
  readonly name: string;
  readonly type: DriveFileType;
  readonly owner: string;
  readonly modified: string;
  readonly size: string;
  readonly mimeType?: string | undefined;
  /** Editor app that owns this file: "docs" | "sheets" | "slides" | null (plain upload). */
  readonly app: string | null;
  readonly starred: boolean;
  /** Short uppercase format label for the per-row chip (e.g. "DOCX", "PDF", "MD"). */
  readonly formatLabel: string;
  readonly preview?: DriveApiPreview | undefined;
}

/** Drive rows historically stored preview metadata in `metadata.preview`.
 *  Normalize that older shape so every list surface can render thumbnails. */
export function previewFromEntry(entry: DriveApiEntry): DriveApiPreview | undefined {
  if (entry.preview !== undefined) {
    return entry.preview;
  }
  const candidate = entry.metadata?.preview;
  return isDriveApiPreview(candidate) ? candidate : undefined;
}

function isDriveApiPreview(value: unknown): value is DriveApiPreview {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<DriveApiPreview>;
  const kind = candidate.kind;
  const status = candidate.status;
  const mimeType = candidate.mimeType;
  return (
    (kind === "text" ||
      kind === "image" ||
      kind === "pdf" ||
      kind === "office" ||
      kind === "unsupported") &&
    (status === "available" || status === "unsupported") &&
    typeof mimeType === "string" &&
    mimeType.length > 0
  );
}

/** Type-colored icon metadata, keyed by file type. */
export const DRIVE_FILE_META: Record<
  DriveFileType,
  { readonly icon: "Doc" | "Sheet" | "Image" | "Video" | "Folder"; readonly color: string }
> = {
  doc: { icon: "Doc", color: "#2563eb" },
  sheet: { icon: "Sheet", color: "#059669" },
  slides: { icon: "Image", color: "#ea580c" },
  pdf: { icon: "Doc", color: "#dc2626" },
  design: { icon: "Image", color: "#ea580c" },
  video: { icon: "Video", color: "#0891b2" },
  folder: { icon: "Folder", color: "#7c3aed" },
};

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Format a byte size into a short, human label (e.g. "184 KB"). */
export function formatByteSize(bytes: number | undefined): string {
  if (bytes === undefined || bytes <= 0) {
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

/** Format an ISO timestamp into a short relative-ish label. */
export function formatModified(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "—";
  }
  const diffMs = Date.now() - then;
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
  if (diffMs < 7 * day) {
    return new Date(then).toLocaleDateString(undefined, { weekday: "long" });
  }
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Extract the trailing extension from a filename. Returns the segment after
 *  the final dot, lowercased, or null when there is no useful extension. */
function extensionFromName(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) {
    return null;
  }
  const ext = name.slice(dot + 1).toLowerCase();
  if (ext.length === 0 || ext.length > 6 || !/^[a-z0-9]+$/i.test(ext)) {
    return null;
  }
  return ext;
}

const MIME_TO_LABEL: ReadonlyArray<readonly [RegExp, string]> = [
  [/application\/pdf/i, "PDF"],
  [/officedocument\.spreadsheetml/i, "XLSX"],
  [/officedocument\.wordprocessingml/i, "DOCX"],
  [/officedocument\.presentationml/i, "PPTX"],
  [/csv/i, "CSV"],
  [/markdown/i, "MD"],
  [/json/i, "JSON"],
  [/zip|x-zip-compressed/i, "ZIP"],
  [/jpeg|jpg/i, "JPG"],
  [/png/i, "PNG"],
  [/gif/i, "GIF"],
  [/svg/i, "SVG"],
  [/mp4|quicktime/i, "VIDEO"],
  [/text\/plain/i, "TXT"],
  [/vnd\.helix\.document/i, "DOC"],
  [/vnd\.helix\.spreadsheet/i, "SHEET"],
  [/vnd\.helix\.presentation/i, "SLIDES"],
];

/** Compute the per-row chip label (e.g. "DOCX") from the entry's metadata.
 *  Prefers `metadata.originalFormat` (the format the file was *imported* from)
 *  when present, falls back to the filename extension, then mime type, then
 *  the app key, then a generic "FILE". Always uppercase, max 6 chars. */
export function formatLabelFromEntry(entry: DriveApiEntry): string {
  if (entry.type === "folder") {
    return "";
  }
  const meta = entry.metadata ?? {};
  const original = typeof meta.originalFormat === "string" ? meta.originalFormat : null;
  if (original && original.length > 0) {
    return original.toUpperCase().slice(0, 6);
  }
  const fromName = extensionFromName(entry.name);
  if (
    fromName !== null &&
    fromName !== "helixdoc" &&
    fromName !== "helixsheet" &&
    fromName !== "helixdeck" &&
    fromName !== "sheet" &&
    fromName !== "slide"
  ) {
    return fromName.toUpperCase();
  }
  if (entry.app === "docs") return "DOC";
  if (entry.app === "sheets") return "SHEET";
  if (entry.app === "slides") return "SLIDES";
  const mime = entry.mimeType ?? "";
  for (const [pattern, label] of MIME_TO_LABEL) {
    if (pattern.test(mime)) {
      return label;
    }
  }
  return "FILE";
}

/** Infer a file type category from a backend entry. */
export function fileTypeFromEntry(entry: DriveApiEntry): DriveFileType {
  if (entry.type === "folder") {
    return "folder";
  }
  const surface = driveEntrySurface(entry);
  if (surface === "docs") return "doc";
  if (surface === "sheets") return "sheet";
  if (surface === "slides") return "slides";
  if (surface === "pdf") return "pdf";
  if (surface === "image") return "design";
  if (surface === "video" || surface === "audio") return "video";
  const name = entry.name.toLowerCase();
  const mime = entry.mimeType?.toLowerCase() ?? "";
  if (mime.includes("figma") || name.endsWith(".fig") || name.endsWith(".sketch")) {
    return "design";
  }
  return "doc";
}

/** Adapt a backend folder entry into a folder tile. */
export function folderItemFromEntry(entry: DriveApiEntry): DriveFolderItem {
  const count = entry.metadata && typeof entry.metadata.itemCount === "number"
    ? entry.metadata.itemCount
    : 0;
  return { id: entry.id, name: entry.name, itemCount: count };
}

/** Adapt a backend file entry into a file card / row model. */
export function fileItemFromEntry(entry: DriveApiEntry): DriveFileItem {
  const preview = previewFromEntry(entry);
  return {
    id: entry.id,
    name: entry.name,
    type: fileTypeFromEntry(entry),
    owner: ownerLabelFromEntry(entry),
    modified: formatModified(entry.updatedAt),
    size: formatByteSize(entry.byteSize),
    ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
    app: entry.app ?? null,
    starred: entry.metadata?.starred === true,
    formatLabel: formatLabelFromEntry(entry),
    ...(preview === undefined ? {} : { preview }),
  };
}

function ownerLabelFromEntry(entry: DriveApiEntry): string {
  return (
    entry.ownerDisplayName?.trim() ||
    entry.ownerEmail?.trim() ||
    entry.ownerActorId?.trim() ||
    "Unknown owner"
  );
}
