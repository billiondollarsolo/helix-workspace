import { describe, expect, it } from "vitest";
import { type DriveApiEntry } from "./api";
import { deriveDriveSuggestions } from "./queries";

function makeEntry(overrides: Partial<DriveApiEntry> & Pick<DriveApiEntry, "id" | "type" | "updatedAt">): DriveApiEntry {
  return {
    name: `entry-${overrides.id}`,
    folderId: null,
    ownerActorId: "owner-1",
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("deriveDriveSuggestions", () => {
  it("splits folders and files from a mixed entry list", () => {
    const entries: DriveApiEntry[] = [
      makeEntry({ id: "f1", type: "folder", updatedAt: "2026-05-20T10:00:00.000Z" }),
      makeEntry({ id: "file1", type: "file", updatedAt: "2026-05-20T09:00:00.000Z" }),
      makeEntry({ id: "f2", type: "folder", updatedAt: "2026-05-19T10:00:00.000Z" }),
      makeEntry({ id: "file2", type: "file", updatedAt: "2026-05-18T10:00:00.000Z" }),
    ];

    const result = deriveDriveSuggestions(entries);

    expect(result.folders).toHaveLength(2);
    expect(result.files).toHaveLength(2);
    expect(result.folders.every((e) => e.type === "folder")).toBe(true);
    expect(result.files.every((e) => e.type === "file")).toBe(true);
  });

  it("returns only folders when no files are present", () => {
    const entries: DriveApiEntry[] = [
      makeEntry({ id: "f1", type: "folder", updatedAt: "2026-05-20T10:00:00.000Z" }),
      makeEntry({ id: "f2", type: "folder", updatedAt: "2026-05-19T10:00:00.000Z" }),
    ];

    const result = deriveDriveSuggestions(entries);

    expect(result.folders).toHaveLength(2);
    expect(result.files).toHaveLength(0);
  });

  it("returns only files when no folders are present", () => {
    const entries: DriveApiEntry[] = [
      makeEntry({ id: "file1", type: "file", updatedAt: "2026-05-20T10:00:00.000Z" }),
      makeEntry({ id: "file2", type: "file", updatedAt: "2026-05-19T10:00:00.000Z" }),
    ];

    const result = deriveDriveSuggestions(entries);

    expect(result.folders).toHaveLength(0);
    expect(result.files).toHaveLength(2);
  });

  it("sorts folders by most-recent updatedAt descending", () => {
    const entries: DriveApiEntry[] = [
      makeEntry({ id: "f-old", type: "folder", updatedAt: "2026-01-01T00:00:00.000Z" }),
      makeEntry({ id: "f-new", type: "folder", updatedAt: "2026-05-20T00:00:00.000Z" }),
      makeEntry({ id: "f-mid", type: "folder", updatedAt: "2026-03-15T00:00:00.000Z" }),
    ];

    const result = deriveDriveSuggestions(entries);

    expect(result.folders.map((e) => e.id)).toEqual(["f-new", "f-mid", "f-old"]);
  });

  it("sorts files by most-recent updatedAt descending", () => {
    const entries: DriveApiEntry[] = [
      makeEntry({ id: "file-old", type: "file", updatedAt: "2026-01-01T00:00:00.000Z" }),
      makeEntry({ id: "file-new", type: "file", updatedAt: "2026-05-20T00:00:00.000Z" }),
      makeEntry({ id: "file-mid", type: "file", updatedAt: "2026-03-15T00:00:00.000Z" }),
    ];

    const result = deriveDriveSuggestions(entries);

    expect(result.files.map((e) => e.id)).toEqual(["file-new", "file-mid", "file-old"]);
  });

  it("limits folders to 5 most recent", () => {
    const entries: DriveApiEntry[] = Array.from({ length: 8 }, (_, i) =>
      makeEntry({
        id: `f${String(i)}`,
        type: "folder",
        updatedAt: new Date(2026, 0, i + 1).toISOString(),
      }),
    );

    const result = deriveDriveSuggestions(entries);

    expect(result.folders).toHaveLength(5);
    // Should be the 5 most recent (indices 7, 6, 5, 4, 3)
    expect(result.folders[0]?.id).toBe("f7");
    expect(result.folders[4]?.id).toBe("f3");
  });

  it("limits files to 10 most recent", () => {
    const entries: DriveApiEntry[] = Array.from({ length: 14 }, (_, i) =>
      makeEntry({
        id: `file${String(i)}`,
        type: "file",
        updatedAt: new Date(2026, 0, i + 1).toISOString(),
      }),
    );

    const result = deriveDriveSuggestions(entries);

    expect(result.files).toHaveLength(10);
    expect(result.files[0]?.id).toBe("file13");
    expect(result.files[9]?.id).toBe("file4");
  });

  it("excludes trashed entries (deletedAt is not null)", () => {
    const entries: DriveApiEntry[] = [
      makeEntry({ id: "f1", type: "folder", updatedAt: "2026-05-20T10:00:00.000Z" }),
      makeEntry({
        id: "f-deleted",
        type: "folder",
        updatedAt: "2026-05-21T10:00:00.000Z",
        deletedAt: "2026-05-21T11:00:00.000Z",
      }),
      makeEntry({ id: "file1", type: "file", updatedAt: "2026-05-20T09:00:00.000Z" }),
      makeEntry({
        id: "file-deleted",
        type: "file",
        updatedAt: "2026-05-21T09:00:00.000Z",
        deletedAt: "2026-05-21T10:00:00.000Z",
      }),
    ];

    const result = deriveDriveSuggestions(entries);

    expect(result.folders.map((e) => e.id)).toEqual(["f1"]);
    expect(result.files.map((e) => e.id)).toEqual(["file1"]);
  });

  it("returns empty arrays for an empty entry list", () => {
    const result = deriveDriveSuggestions([]);

    expect(result.folders).toHaveLength(0);
    expect(result.files).toHaveLength(0);
  });

  it("uses the updatedAt field (not createdAt) for sorting", () => {
    const entries: DriveApiEntry[] = [
      makeEntry({
        id: "f-recently-updated",
        type: "folder",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-05-20T10:00:00.000Z",
      }),
      makeEntry({
        id: "f-recently-created",
        type: "folder",
        createdAt: "2026-05-19T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ];

    const result = deriveDriveSuggestions(entries);

    // f-recently-updated has newer updatedAt, so it comes first
    expect(result.folders[0]?.id).toBe("f-recently-updated");
    expect(result.folders[1]?.id).toBe("f-recently-created");
  });
});
