import { describe, expect, it, vi } from "vitest";
import { createDriveSearchIndexer, driveRecordToIndexDocument } from "./indexer.js";

describe("Drive search ACL projection", () => {
  it("indexes only the explicit discovery principals", () => {
    const document = driveRecordToIndexDocument({
      id: "file-1",
      orgId: "org-1",
      kind: "file",
      name: "Private plan",
      mimeType: "text/plain",
      byteSize: 12,
      storageKey: "org-1/objects/private-plan",
      sha256: "secret-content-digest",
      allowedActorIds: ["owner-1", "reader-1"],
      metadata: { internalLocator: "must-not-be-indexed" },
      createdAt: "2026-09-02T00:00:00.000Z",
    });

    expect(document.attributes).toMatchObject({
      orgId: "org-1",
      allowedActorIds: ["owner-1", "reader-1"],
      ragVisibility: "org",
    });
    expect(Object.keys(document.attributes ?? {}).sort()).toEqual([
      "allowedActorIds",
      "byteSize",
      "createdAt",
      "fileId",
      "kind",
      "mimeType",
      "orgId",
      "path",
      "ragVisibility",
      "tags",
    ]);
    expect(JSON.stringify(document)).not.toContain("private-plan");
    expect(JSON.stringify(document)).not.toContain("secret-content-digest");
    expect(JSON.stringify(document)).not.toContain("internalLocator");
  });

  it("removes an existing search/RAG document when antivirus quarantines the file", async () => {
    const getDriveSearchRecord = vi.fn(async () => null);
    const indexer = createDriveSearchIndexer({ getDriveSearchRecord });

    await expect(
      indexer.route({
        subject: "activity.drive.upload.quarantined",
        payload: { orgId: "org-1", objectId: "file-1" },
        occurredAt: "2026-09-02T00:00:00.000Z",
      }),
    ).resolves.toEqual({ delete: ["drive:file-1"] });
    expect(getDriveSearchRecord).toHaveBeenCalledWith("file-1");
  });
});
