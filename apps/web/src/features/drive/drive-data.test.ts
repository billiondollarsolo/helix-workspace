import { describe, expect, it } from "vitest";
import type { DriveApiEntry } from "./api";
import {
  canDeleteForever,
  driveItemFromEntry,
  fileTypeFromName,
  formatByteSize,
  trashRetentionDays,
} from "./drive-data";

function makeEntry(
  overrides: Partial<DriveApiEntry> & Pick<DriveApiEntry, "id" | "type">,
): DriveApiEntry {
  return {
    name: `entry-${overrides.id}`,
    folderId: null,
    ownerActorId: "11111111-1111-4111-8111-111111111111",
    metadata: {},
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("formatByteSize", () => {
  it("returns an em dash for missing or zero sizes", () => {
    expect(formatByteSize(undefined)).toBe("—");
    expect(formatByteSize(null)).toBe("—");
    expect(formatByteSize(0)).toBe("—");
  });
  it("scales bytes into the largest fitting unit", () => {
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(184 * 1024)).toBe("184 KB");
    expect(formatByteSize(4 * 1024 * 1024)).toBe("4 MB");
  });
});

describe("fileTypeFromName", () => {
  it.each([
    ["photo.png", "image/png", "image"],
    ["scan.heic", null, "image"],
    ["song.mp3", null, "audio"],
    ["talk.mov", null, "video"],
    ["report.pdf", "application/pdf", "pdf"],
    ["notes.txt", "text/plain", "doc"],
    ["letter.docx", null, "doc"],
    ["budget.xlsx", null, "sheet"],
    ["data.csv", "text/csv", "sheet"],
    ["pitch.pptx", null, "slides"],
    ["memo.m4a", "audio/mp4", "audio"],
    ["clip.mp4", "video/mp4", "video"],
    ["backup.zip", "application/zip", "archive"],
    ["main.ts", null, "code"],
    ["config.json", "application/json", "code"],
    ["mystery.bin", "application/octet-stream", "other"],
  ] as const)("%s (%s) is a %s", (name, mime, type) => {
    expect(fileTypeFromName(name, mime)).toBe(type);
  });
});

describe("driveItemFromEntry", () => {
  it("maps folders as always-available folder items", () => {
    const item = driveItemFromEntry(makeEntry({ id: "f", type: "folder", name: "Plans" }));
    expect(item).toMatchObject({ kind: "folder", type: "folder", available: true, byteSize: null });
  });

  it("keeps a file unavailable until its scan is clean", () => {
    const scanning = driveItemFromEntry(
      makeEntry({ id: "a", type: "file", name: "a.pdf", uploadState: "scanning" }),
    );
    expect(scanning).toMatchObject({ available: false, uploadStatusLabel: "Scanning for malware" });
    const clean = driveItemFromEntry(
      makeEntry({
        id: "b",
        type: "file",
        name: "b.pdf",
        uploadState: "active",
        metadata: { starred: true },
        byteSize: 2048,
      }),
    );
    expect(clean).toMatchObject({ available: true, starred: true, type: "pdf", byteSize: 2048 });
  });

  it("prefers the owner's display name", () => {
    const item = driveItemFromEntry(
      makeEntry({ id: "c", type: "file", ownerDisplayName: "Avery Park" }),
    );
    expect(item.owner).toBe("Avery Park");
  });
});

describe("trash retention", () => {
  const trashed = (deletedAt: string, trashPurgeAfter: string | null) =>
    driveItemFromEntry(makeEntry({ id: deletedAt, type: "file", deletedAt, trashPurgeAfter }));

  it("reads the retention period from the server's purge deadlines", () => {
    expect(
      trashRetentionDays([trashed("2026-03-01T00:00:00.000Z", "2026-03-15T00:00:00.000Z")]),
    ).toBe(14);
    expect(trashRetentionDays([trashed("2026-03-01T00:00:00.000Z", null)])).toBeNull();
    expect(trashRetentionDays([])).toBeNull();
  });

  it("allows delete forever only after the recovery window", () => {
    const item = trashed("2026-03-01T00:00:00.000Z", "2026-03-31T00:00:00.000Z");
    expect(canDeleteForever(item, Date.parse("2026-03-30T00:00:00.000Z"))).toBe(false);
    expect(canDeleteForever(item, Date.parse("2026-03-31T00:00:00.000Z"))).toBe(true);
    expect(canDeleteForever(trashed("2026-03-01T00:00:00.000Z", null))).toBe(false);
  });
});
