import { describe, expect, it } from "vitest";
import { parseDriveSearchQuery } from "./search-query.js";

describe("parseDriveSearchQuery", () => {
  it("strips type and owner operators from the name query", () => {
    expect(parseDriveSearchQuery("type:pdf owner:me Q3 roadmap")).toEqual({
      text: "Q3 roadmap",
      mimeContains: "%pdf%",
      nameSuffix: "%.pdf",
      ownerMe: true,
      foldersOnly: false,
      includeFolders: false,
    });
  });

  it("treats type:folder as a folder-only search", () => {
    expect(parseDriveSearchQuery('type:folder "Harbor"')).toMatchObject({
      text: "Harbor",
      foldersOnly: true,
      includeFolders: true,
    });
  });

  it("includes folders for a plain name search", () => {
    expect(parseDriveSearchQuery("Admin note")).toMatchObject({
      text: "Admin note",
      includeFolders: true,
      foldersOnly: false,
      ownerMe: false,
    });
  });
});
