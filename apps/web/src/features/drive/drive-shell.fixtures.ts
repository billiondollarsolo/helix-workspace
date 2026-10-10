/** Shared DriveShell test fixtures. */
import type { DriveApiEntry } from "./api";

/** The first selectable file card/row — `aria-pressed` buttons that are not
 *  the `.btn`-classed grid/list toggle buttons. */
export function firstFileCard(container: HTMLElement): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")).find(
      (button) => !button.classList.contains("btn") && !button.classList.contains("icon-btn"),
    ) ?? null
  );
}
export function fileButton(container: HTMLElement, name: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")).find(
      (button) =>
        !button.classList.contains("btn") &&
        !button.classList.contains("icon-btn") &&
        button.textContent?.includes(name),
    ) ?? null
  );
}
export function entry(
  overrides: Partial<DriveApiEntry> & Pick<DriveApiEntry, "id" | "type" | "name">,
): DriveApiEntry {
  return {
    folderId: null,
    ownerActorId: "owner-1",
    uploadState: "active",
    available: true,
    metadata: {},
    deletedAt: null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
    ...overrides,
  };
}
export const ROOT_ENTRIES: readonly DriveApiEntry[] = [
  entry({ id: "folder-eng", type: "folder", name: "Engineering" }),
  entry({
    id: "file-specs",
    type: "file",
    name: "Specs.pdf",
    mimeType: "application/pdf",
    byteSize: 1024,
  }),
  entry({
    id: "file-roadmap",
    type: "file",
    name: "Roadmap.docx",
    mimeType: "application/msword",
    byteSize: 2048,
  }),
  entry({
    id: "file-budget",
    type: "file",
    name: "Budget.xlsx",
    mimeType: "application/vnd.ms-excel",
    byteSize: 4096,
  }),
];
export const FOLDER_CHILDREN: readonly DriveApiEntry[] = [
  entry({
    id: "file-nested",
    type: "file",
    name: "Nested-spec.pdf",
    folderId: "folder-eng",
    mimeType: "application/pdf",
  }),
];
