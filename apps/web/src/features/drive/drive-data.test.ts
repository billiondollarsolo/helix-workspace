import { describe, expect, it } from "vitest";
import type { DriveApiEntry } from "./api";
import {
  fileItemFromEntry,
  fileTypeFromEntry,
  folderItemFromEntry,
  formatByteSize,
} from "./drive-data";

function makeEntry(overrides: Partial<DriveApiEntry> & Pick<DriveApiEntry, "id" | "type">): DriveApiEntry {
  return {
    name: `entry-${overrides.id}`,
    folderId: null,
    ownerActorId: "Alex Park",
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("formatByteSize", () => {
  it("returns an em dash for missing or zero sizes", () => {
    expect(formatByteSize(undefined)).toBe("—");
    expect(formatByteSize(0)).toBe("—");
  });

  it("scales bytes into the largest fitting unit", () => {
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(184 * 1024)).toBe("184 KB");
    expect(formatByteSize(4 * 1024 * 1024)).toBe("4 MB");
  });
});

describe("fileTypeFromEntry", () => {
  it("classifies folders", () => {
    expect(fileTypeFromEntry(makeEntry({ id: "1", type: "folder" }))).toBe("folder");
  });

  it("infers types from mime and name", () => {
    expect(
      fileTypeFromEntry(makeEntry({ id: "2", type: "file", mimeType: "application/pdf" })),
    ).toBe("pdf");
    expect(fileTypeFromEntry(makeEntry({ id: "3", type: "file", name: "deck.fig" }))).toBe(
      "design",
    );
    expect(
      fileTypeFromEntry(makeEntry({ id: "4", type: "file", mimeType: "video/mp4" })),
    ).toBe("video");
    expect(fileTypeFromEntry(makeEntry({ id: "5", type: "file", name: "notes.txt" }))).toBe(
      "doc",
    );
  });
});

describe("entry adapters", () => {
  it("maps a folder entry with an item count from metadata", () => {
    const folder = folderItemFromEntry(
      makeEntry({ id: "f1", type: "folder", name: "Design", metadata: { itemCount: 12 } }),
    );
    expect(folder).toMatchObject({ id: "f1", name: "Design", itemCount: 12 });
  });

  it("maps a file entry into a card model", () => {
    const file = fileItemFromEntry(
      makeEntry({
        id: "x1",
        type: "file",
        name: "Q3-Forecast.xlsx",
        byteSize: 184 * 1024,
        ownerActorId: "Naveen Iyer",
      }),
    );
    expect(file).toMatchObject({
      id: "x1",
      name: "Q3-Forecast.xlsx",
      type: "sheet",
      owner: "Naveen Iyer",
      size: "184 KB",
    });
  });

  it("falls back to a placeholder owner when none is set", () => {
    const file = fileItemFromEntry(
      makeEntry({ id: "x2", type: "file", ownerActorId: null }),
    );
    expect(file.owner).toBe("Unknown owner");
  });
});
