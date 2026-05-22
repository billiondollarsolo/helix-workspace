/* Drive seed data + mapping helpers.
   Ports the design handoff DRIVE_FOLDERS / DRIVE_FILES seed as typed values
   and adapts backend DriveApiEntry rows into the view model the Drive shell
   renders. The seed is used as an offline fallback when the backend
   suggestions query yields nothing. */

import type { DriveApiEntry } from "./api";

/** A file's visual category — drives the type-colored icon. */
export type DriveFileType = "doc" | "sheet" | "pdf" | "design" | "video" | "folder";

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
  /** Editor app that owns this file: "docs" | "sheets" | "slides" | null (plain upload). */
  readonly app: string | null;
}

/** Type-colored icon metadata, keyed by file type. */
export const DRIVE_FILE_META: Record<
  DriveFileType,
  { readonly icon: "Doc" | "Sheet" | "Image" | "Video" | "Folder"; readonly color: string }
> = {
  doc: { icon: "Doc", color: "#2563eb" },
  sheet: { icon: "Sheet", color: "#059669" },
  pdf: { icon: "Doc", color: "#dc2626" },
  design: { icon: "Image", color: "#ea580c" },
  video: { icon: "Video", color: "#0891b2" },
  folder: { icon: "Folder", color: "#7c3aed" },
};

/** Seed folders ported from the handoff DRIVE_FOLDERS. */
export const DRIVE_FOLDERS_SEED: readonly DriveFolderItem[] = [
  { id: "seed-folder-product", name: "Product", itemCount: 42 },
  { id: "seed-folder-engineering", name: "Engineering", itemCount: 128 },
  { id: "seed-folder-design", name: "Design", itemCount: 86 },
  { id: "seed-folder-sales", name: "Sales", itemCount: 24 },
  { id: "seed-folder-operations", name: "Operations", itemCount: 36 },
];

/** Seed files ported from the handoff DRIVE_FILES. */
export const DRIVE_FILES_SEED: readonly DriveFileItem[] = [
  {
    id: "seed-file-q3-roadmap",
    name: "Q3 Roadmap — final draft",
    type: "doc",
    owner: "Mira Okafor",
    modified: "10 min ago",
    size: "—",
    app: null,
  },
  {
    id: "seed-file-q3-forecast",
    name: "Q3-Forecast.xlsx",
    type: "sheet",
    owner: "Naveen Iyer",
    modified: "1 hour ago",
    size: "184 KB",
    app: null,
  },
  {
    id: "seed-file-brand-mark",
    name: "Helix-brand-mark.fig",
    type: "design",
    owner: "Priya Anand",
    modified: "2 hours ago",
    size: "12.4 MB",
    app: null,
  },
  {
    id: "seed-file-atlas-deck",
    name: "Atlas-renewal-deck.pdf",
    type: "pdf",
    owner: "Rumi Tanaka",
    modified: "Yesterday",
    size: "4.1 MB",
    app: null,
  },
  {
    id: "seed-file-onboarding-mocks",
    name: "Onboarding-mocks-v3.fig",
    type: "design",
    owner: "Priya Anand",
    modified: "Yesterday",
    size: "8.9 MB",
    app: null,
  },
  {
    id: "seed-file-onsite-recording",
    name: "Engineering-onsite-recording.mp4",
    type: "video",
    owner: "Daniel Cho",
    modified: "Monday",
    size: "1.2 GB",
    app: null,
  },
  {
    id: "seed-file-eu-dpa",
    name: "EU-DPA-template.docx",
    type: "doc",
    owner: "Iris Lambert",
    modified: "Last week",
    size: "92 KB",
    app: null,
  },
  {
    id: "seed-file-brand-photography",
    name: "Brand-photography-2026",
    type: "folder",
    owner: "Owen Hart",
    modified: "Last week",
    size: "—",
    app: null,
  },
  {
    id: "seed-file-salary-bands",
    name: "Salary-bands-FY26.xlsx",
    type: "sheet",
    owner: "Sasha Levin",
    modified: "Last week",
    size: "76 KB",
    app: null,
  },
];

/** People shown in the details panel "Shared with" stack. */
export const DRIVE_SHARED_WITH: readonly string[] = ["Mira Okafor", "Jonas Reichert", "Priya Anand"];

/** Storage meter copy + fill, ported from the handoff. */
export const DRIVE_STORAGE = {
  /** Fraction of quota used, 0–1. */
  fraction: 0.48,
  label: "2.4 TB of 5 TB used",
} as const;

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

const MIME_TYPE_MAP: ReadonlyArray<readonly [RegExp, DriveFileType]> = [
  [/sheet|excel|csv|\.xlsx?$/i, "sheet"],
  [/pdf/i, "pdf"],
  [/image|figma|sketch|design|\.fig$|\.sketch$|\.psd$/i, "design"],
  [/video|audio|\.mp4$|\.mov$/i, "video"],
  [/word|document|text|markdown|presentation/i, "doc"],
];

/** Infer a file type category from a backend entry. */
export function fileTypeFromEntry(entry: DriveApiEntry): DriveFileType {
  if (entry.type === "folder") {
    return "folder";
  }
  const mime = entry.mimeType ?? "";
  const name = entry.name;
  for (const [pattern, type] of MIME_TYPE_MAP) {
    if (pattern.test(mime) || pattern.test(name)) {
      return type;
    }
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
  return {
    id: entry.id,
    name: entry.name,
    type: fileTypeFromEntry(entry),
    owner: entry.ownerActorId ?? "Unknown owner",
    modified: formatModified(entry.updatedAt),
    size: formatByteSize(entry.byteSize),
    app: entry.app ?? null,
  };
}
