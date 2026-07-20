import { describe, expect, it } from "vitest";
import {
  isDriveBlobStorageKey,
  resolveBlobByteSource,
  resolveFinalizeStorageKey,
  shouldDeleteBlobStorage,
  shouldWriteBlobBytes,
} from "./dedup.js";

describe("dedup pure helpers", () => {
  it("resolves blob key only when dedup is on", () => {
    expect(
      resolveFinalizeStorageKey({
        dedup: false,
        orgId: "org",
        sha256: "a".repeat(64),
        reservedKey: "drive/org/obj/v1/f",
      }),
    ).toBe("drive/org/obj/v1/f");
    expect(
      resolveFinalizeStorageKey({
        dedup: true,
        orgId: "org",
        sha256: "ab".repeat(32),
        reservedKey: "drive/org/obj/v1/f",
      }),
    ).toBe(`drive/org/blobs/${"ab".repeat(32)}`);
  });

  it("writes blob bytes only on first ref when dedup is on", () => {
    expect(shouldWriteBlobBytes({ dedup: false, blobRowInserted: true })).toBe(false);
    expect(shouldWriteBlobBytes({ dedup: true, blobRowInserted: true })).toBe(true);
    expect(shouldWriteBlobBytes({ dedup: true, blobRowInserted: false })).toBe(false);
  });

  it("prefers inline content then reserved key for blob source", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(resolveBlobByteSource({ content: bytes, reservedKey: "drive/o/x" })).toEqual({
      kind: "inline",
      content: bytes,
    });
    expect(resolveBlobByteSource({ content: undefined, reservedKey: "drive/o/x" })).toEqual({
      kind: "reserved",
      reservedKey: "drive/o/x",
    });
    expect(resolveBlobByteSource({ content: undefined, reservedKey: "" })).toEqual({
      kind: "missing",
    });
  });

  it("deletes blob storage only when refcount hits zero", () => {
    expect(shouldDeleteBlobStorage(1)).toBe(false);
    expect(shouldDeleteBlobStorage(0)).toBe(true);
    expect(shouldDeleteBlobStorage(-1)).toBe(true);
  });

  it("detects blob storage keys", () => {
    expect(isDriveBlobStorageKey(`drive/org/blobs/${"ab".repeat(32)}`)).toBe(true);
    expect(isDriveBlobStorageKey("drive/org/obj/v1/file.pdf")).toBe(false);
  });
});
