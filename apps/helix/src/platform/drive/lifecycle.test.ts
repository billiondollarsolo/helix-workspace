import { describe, expect, it, vi } from "vitest";
import { collectDriveOrphans, driveHardDeleteBlockers } from "./lifecycle.js";

describe("Drive lifecycle", () => {
  it("blocks hard delete for retention, holds, shares, and pending jobs", () => {
    const now = new Date("2026-07-28T12:00:00.000Z");
    expect(
      driveHardDeleteBlockers(
        {
          trashedAt: new Date("2026-07-01T00:00:00.000Z"),
          trashExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
          legalHold: true,
          activeShareCount: 1,
          pendingJobCount: 1,
        },
        now,
      ),
    ).toEqual(["retention", "legal_hold", "active_shares", "pending_jobs"]);
  });

  it("supports dry-run and aborts multipart before marking it collected", async () => {
    const candidates = [
      {
        id: "upload-a",
        orgId: "org-a",
        storageKey: "reserved-a",
        kind: "multipart" as const,
        uploadId: "multipart-a",
      },
      { id: "blob-a", orgId: "org-a", storageKey: "blob-a", kind: "blob" as const },
    ];
    const markCollected = vi.fn();
    const abortMultipart = vi.fn();
    const deleteBlob = vi.fn();
    const repository = {
      listCandidates: vi.fn().mockResolvedValue(candidates),
      markCollected,
    };
    const storage = { abortMultipart, delete: deleteBlob };

    await expect(
      collectDriveOrphans({
        repository,
        storage,
        olderThan: new Date(),
        dryRun: true,
      }),
    ).resolves.toEqual({ candidates: 2, collected: 0 });
    expect(abortMultipart).not.toHaveBeenCalled();

    await expect(
      collectDriveOrphans({
        repository,
        storage,
        olderThan: new Date(),
        dryRun: false,
      }),
    ).resolves.toEqual({ candidates: 2, collected: 2 });
    expect(abortMultipart).toHaveBeenCalledWith("org-a", "reserved-a", "multipart-a");
    expect(deleteBlob).toHaveBeenCalledWith("org-a", "blob-a");
    expect(markCollected).toHaveBeenCalledTimes(2);
  });
});
