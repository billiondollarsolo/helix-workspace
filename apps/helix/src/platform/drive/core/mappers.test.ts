import { describe, expect, it } from "vitest";
import { mapDriveAccessGrant, mapObjectEntry } from "./mappers.js";

describe("mapObjectEntry", () => {
  it("lifts folder/app/preview out of metadata jsonb into typed fields", () => {
    const entry = mapObjectEntry({
      id: "11111111-1111-4111-8111-111111111111",
      owner_actor_id: "a",
      storage_key: "drive/o/x/v1/f.pdf",
      mime_type: "application/pdf",
      byte_size: 10,
      sha256: "d".repeat(64),
      metadata: {
        name: "f.pdf",
        folderId: "44444444-4444-4444-8444-444444444444",
        app: "docs",
        starred: true,
      },
      deleted_at: null,
      created_at: new Date("2026-07-18T00:00:00Z"),
      updated_at: new Date("2026-07-18T00:00:00Z"),
      version_number: 3,
    });
    expect(entry.type).toBe("file");
    expect(entry.folderId).toBe("44444444-4444-4444-8444-444444444444");
    expect(entry.app).toBe("docs");
    expect(entry.versionNumber).toBe(3);
    expect(entry.name).toBe("f.pdf");
  });

  it("projects upload/scan lifecycle onto entry for D8 list badges", () => {
    const entry = mapObjectEntry({
      id: "11111111-1111-4111-8111-111111111111",
      owner_actor_id: "a",
      storage_key: "drive/o/x/v1/bad.bin",
      mime_type: "application/octet-stream",
      byte_size: 3,
      sha256: "d".repeat(64),
      metadata: { name: "bad.bin" },
      deleted_at: null,
      created_at: new Date("2026-07-18T00:00:00Z"),
      updated_at: new Date("2026-07-18T00:00:00Z"),
      upload_state: "quarantined",
    });
    expect(entry.uploadState).toBe("quarantined");
    expect(entry.available).toBe(false);
    expect(entry.uploadStatusLabel).toBe("Quarantined");
  });
});

describe("mapDriveAccessGrant", () => {
  it("maps a permissions row to a grant record", () => {
    const grant = mapDriveAccessGrant({
      actor_id: "55555555-5555-4555-8555-555555555555",
      role: "editor",
      display_name: "Mo",
      email: "mo@x.io",
      granted_by_actor_id: null,
      expires_at: null,
      created_at: new Date("2026-07-18T00:00:00Z"),
      updated_at: new Date("2026-07-18T00:00:00Z"),
    });
    expect(grant.role).toBe("editor");
    expect(grant.displayName).toBe("Mo");
  });
});
