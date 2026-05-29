import { detectFormat, type EditorSurface } from "@/features/_open/format-detection";
import type { DriveApiEntry } from "./api";

export function driveEntrySurface(entry: Pick<DriveApiEntry, "app" | "mimeType" | "name">): EditorSurface {
  if (entry.app === "docs") return "docs";
  if (entry.app === "sheets") return "sheets";
  if (entry.app === "slides") return "slides";
  return detectFormat(entry.name, entry.mimeType).surface;
}

export function driveEntryBelongsToSurface(
  entry: Pick<DriveApiEntry, "app" | "mimeType" | "name">,
  surface: EditorSurface,
): boolean {
  return driveEntrySurface(entry) === surface;
}
