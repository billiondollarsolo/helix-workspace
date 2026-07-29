import { describe, expect, it } from "vitest";
import {
  DRIVE_ROLES,
  driveEntrySchema,
  driveRoleSchema,
  driveUploadStateSchema,
  driveUploadStatusSchema,
  driveUploadResultSchema,
} from "./drive.js";

describe("drive contracts", () => {
  it("exposes the four canonical roles", () => {
    expect(DRIVE_ROLES).toEqual(["reader", "commenter", "editor", "owner"]);
    expect(driveRoleSchema.parse("editor")).toBe("editor");
    expect(() => driveRoleSchema.parse("viewer")).toThrow();
  });

  it("parses a serialized drive entry (ISO date strings)", () => {
    const parsed = driveEntrySchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      type: "file",
      name: "q3.pdf",
      folderId: null,
      ownerActorId: "22222222-2222-4222-8222-222222222222",
      metadata: {},
      deletedAt: null,
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    });
    expect(parsed.name).toBe("q3.pdf");
  });

  it("rejects a drive entry with a non-uuid id", () => {
    expect(() =>
      driveEntrySchema.parse({
        id: "nope",
        type: "file",
        name: "x",
        folderId: null,
        ownerActorId: null,
        metadata: {},
        deletedAt: null,
        createdAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("upload result carries a nullable uploadUrl and headers map", () => {
    const parsed = driveUploadResultSchema.parse({
      objectId: "33333333-3333-4333-8333-333333333333",
      orgId: "44444444-4444-4444-8444-444444444444",
      ownerActorId: "55555555-5555-4555-8555-555555555555",
      name: "a.bin",
      folderId: null,
      storageKey: "drive/o/x/v1/a.bin",
      mimeType: "application/octet-stream",
      byteSize: 3,
      sha256: null,
      status: "pending_upload",
      uploadUrl: null,
      uploadHeaders: {},
      metadata: {},
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    });
    expect(parsed.uploadUrl).toBeNull();
  });

  it("exposes only explicit upload lifecycle states and a status-only DTO", () => {
    expect(driveUploadStateSchema.parse("scanning")).toBe("scanning");
    expect(() => driveUploadStateSchema.parse("ready")).toThrow();
    expect(
      driveUploadStatusSchema.parse({
        objectId: "33333333-3333-4333-8333-333333333333",
        state: "quarantined",
        label: "Quarantined",
        available: false,
        terminal: true,
        updatedAt: "2026-07-28T00:00:00.000Z",
      }).available,
    ).toBe(false);
  });
});
