import { describe, expect, it } from "vitest";
import { driveBlobKey, driveQuarantineStorageKey, driveStorageKey } from "./storage-key.js";

describe("driveStorageKey", () => {
  it("builds the versioned key with a sanitized name", () => {
    expect(driveStorageKey("org1", "obj1", 1, "Q3 Report/../x.pdf")).toBe(
      "drive/org1/obj1/v1/Q3_Report_.._x.pdf",
    );
  });

  it("falls back to 'upload' when the name sanitizes to empty", () => {
    expect(driveStorageKey("o", "x", 2, "")).toBe("drive/o/x/v2/upload");
  });
});

describe("driveBlobKey", () => {
  it("builds the content-addressed blob path", () => {
    expect(driveBlobKey("o", "ab".repeat(32))).toBe(`drive/o/blobs/${"ab".repeat(32)}`);
  });
});

describe("driveQuarantineStorageKey", () => {
  it("isolates rejected bytes from readable Drive objects", () => {
    expect(driveQuarantineStorageKey("o", "x", "ab".repeat(32))).toBe(
      `drive-quarantine/o/x/${"ab".repeat(32)}`,
    );
  });
});
