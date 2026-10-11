import { describe, expect, it } from "vitest";
import { driveItemFromEntry, type DriveItem } from "./drive-data";
import {
  drivePeopleOptions,
  filterDriveItems,
  hasDriveFilters,
  NO_DRIVE_FILTERS,
  sortDriveItems,
} from "./drive-sort-filter";
import { entry, ME, OTHER } from "./drive-test-server";

const items: DriveItem[] = [
  entry({ id: "f-zeta", type: "folder", name: "Zeta", updatedAt: "2026-05-01T00:00:00Z" }),
  entry({ id: "f-alpha", type: "folder", name: "alpha", updatedAt: "2026-05-03T00:00:00Z" }),
  entry({
    id: "doc-10",
    type: "file",
    name: "Notes 10.docx",
    byteSize: 300,
    updatedAt: "2026-05-02T00:00:00Z",
  }),
  entry({
    id: "doc-9",
    type: "file",
    name: "Notes 9.docx",
    byteSize: 900,
    updatedAt: "2026-05-04T00:00:00Z",
    ownerActorId: OTHER,
    ownerDisplayName: "Sam Patel",
  }),
  entry({
    id: "pdf",
    type: "file",
    name: "Budget.pdf",
    mimeType: "application/pdf",
    byteSize: 50,
    updatedAt: "2025-12-31T00:00:00Z",
  }),
].map(driveItemFromEntry);

const ids = (list: readonly DriveItem[]) => list.map((item) => item.id);
const context = { actorId: ME, openedAt: new Map<string, number>() };

describe("sortDriveItems", () => {
  it("keeps folders on top and sorts names naturally", () => {
    expect(ids(sortDriveItems(items, { key: "name", direction: "asc" }, context))).toEqual([
      "f-alpha",
      "f-zeta",
      "pdf",
      "doc-9",
      "doc-10",
    ]);
    expect(ids(sortDriveItems(items, { key: "name", direction: "desc" }, context))).toEqual([
      "f-zeta",
      "f-alpha",
      "doc-10",
      "doc-9",
      "pdf",
    ]);
  });

  it("sorts by last modified and by size, folders still first", () => {
    expect(ids(sortDriveItems(items, { key: "modified", direction: "desc" }, context))).toEqual([
      "f-alpha",
      "f-zeta",
      "doc-9",
      "doc-10",
      "pdf",
    ]);
    expect(ids(sortDriveItems(items, { key: "size", direction: "desc" }, context))).toEqual([
      "f-alpha",
      "f-zeta",
      "doc-9",
      "doc-10",
      "pdf",
    ]);
  });

  it("puts items modified or opened by me first", () => {
    expect(
      ids(sortDriveItems(items, { key: "modified-by-me", direction: "desc" }, context)).slice(2),
    ).toEqual(["doc-10", "pdf", "doc-9"]);
    const opened = {
      actorId: ME,
      openedAt: new Map([
        ["pdf", 20],
        ["doc-9", 10],
      ]),
    };
    expect(
      ids(sortDriveItems(items, { key: "opened-by-me", direction: "desc" }, opened)).slice(2),
    ).toEqual(["pdf", "doc-9", "doc-10"]);
  });
});

describe("filterDriveItems", () => {
  const now = new Date("2026-05-04T12:00:00Z");

  it("filters by type", () => {
    const filtered = filterDriveItems(items, { ...NO_DRIVE_FILTERS, type: "pdf" }, { actorId: ME });
    expect(ids(filtered)).toEqual(["pdf"]);
    expect(
      ids(filterDriveItems(items, { ...NO_DRIVE_FILTERS, type: "folder" }, { actorId: ME })),
    ).toEqual(["f-zeta", "f-alpha"]);
  });

  it("filters by owner", () => {
    const mine = filterDriveItems(
      items,
      { ...NO_DRIVE_FILTERS, people: { kind: "me" } },
      { actorId: ME },
    );
    expect(ids(mine)).not.toContain("doc-9");
    const sam = filterDriveItems(
      items,
      { ...NO_DRIVE_FILTERS, people: { kind: "owner", actorId: OTHER, label: "Sam Patel" } },
      { actorId: ME },
    );
    expect(ids(sam)).toEqual(["doc-9"]);
    expect(drivePeopleOptions(items, ME)).toEqual([{ actorId: OTHER, label: "Sam Patel" }]);
  });

  it("filters by modified date", () => {
    expect(
      ids(
        filterDriveItems(items, { ...NO_DRIVE_FILTERS, modified: "today" }, { actorId: ME, now }),
      ),
    ).toEqual(["doc-9"]);
    expect(
      ids(
        filterDriveItems(
          items,
          { ...NO_DRIVE_FILTERS, modified: "last-year" },
          { actorId: ME, now },
        ),
      ),
    ).toEqual(["pdf"]);
    expect(
      filterDriveItems(items, { ...NO_DRIVE_FILTERS, modified: "week" }, { actorId: ME, now }),
    ).toHaveLength(4);
  });

  it("knows when any chip is active", () => {
    expect(hasDriveFilters(NO_DRIVE_FILTERS)).toBe(false);
    expect(hasDriveFilters({ ...NO_DRIVE_FILTERS, modified: "month" })).toBe(true);
  });
});
