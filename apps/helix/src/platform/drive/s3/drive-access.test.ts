import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import type { DriveEntryRecord } from "../types.js";
import { DRIVE_S3_BUCKETS } from "./buckets.js";
import { ensureDriveS3Folders, type DriveS3Access, type DriveS3Store } from "./drive-access.js";
import { driveFolderChildrenLockKey } from "./folder-transaction.js";

const actor: Actor = {
  id: "user",
  orgId: "org",
  type: "user",
  scopes: ["drive.read", "drive.write"],
};

/** A Drive with folders only, recording whether each write ran in its own transaction. */
function folderStore() {
  const folders: { id: string; name: string; parent: string | null }[] = [];
  const writes: { name: string; ownTransaction: boolean }[] = [];
  const locks: (string | null)[] = [];
  let inOwnTransaction = false;
  const store = {
    list: async (input: { readonly folderId: string | null }) => ({
      entries: folders
        .filter((folder) => folder.parent === input.folderId)
        .map(
          (folder) => ({ id: folder.id, name: folder.name, type: "folder" }) as DriveEntryRecord,
        ),
      nextCursor: null,
    }),
    createFolder: async (input: {
      readonly name: string;
      readonly parentFolderId?: string | null;
    }) => {
      const folder = {
        id: `f${String(folders.length + 1)}`,
        name: input.name,
        parent: input.parentFolderId ?? null,
      };
      folders.push(folder);
      writes.push({ name: input.name, ownTransaction: inOwnTransaction });
      return { id: folder.id, name: folder.name, type: "folder" } as DriveEntryRecord;
    },
  } as unknown as DriveS3Store;
  const inOwn = async <T>(
    work: (lock: (parentFolderId: string | null) => Promise<void>) => Promise<T>,
  ): Promise<T> => {
    inOwnTransaction = true;
    try {
      return await work(async (parentFolderId) => {
        locks.push(parentFolderId);
      });
    } finally {
      inOwnTransaction = false;
    }
  };
  return { store, writes, locks, inOwn };
}

function access(store: DriveS3Store, inOwnTransaction?: DriveS3Access["inOwnTransaction"]) {
  return {
    store,
    actor,
    bucket: DRIVE_S3_BUCKETS["my-drive"],
    traceId: "trace",
    inOwnTransaction,
  } satisfies DriveS3Access;
}

describe("ensureDriveS3Folders", () => {
  it("creates a key's missing prefix folders in their own committed transaction", async () => {
    const { store, writes, locks, inOwn } = folderStore();

    const folderId = await ensureDriveS3Folders(access(store, inOwn), ["reports", "2026"]);

    expect(folderId).toBe("f2");
    // The object upload that follows runs in separate saga transactions, which
    // only see these folders once they are committed.
    expect(writes).toEqual([
      { name: "reports", ownTransaction: true },
      { name: "2026", ownTransaction: true },
    ]);
    // Each parent's children are locked, root first, before they are looked up.
    expect(locks).toEqual([null, "f1"]);
  });

  it("reuses existing folders and needs no transaction for the bucket root", async () => {
    const { store, writes, inOwn } = folderStore();
    await ensureDriveS3Folders(access(store, inOwn), ["reports"]);
    let wrapped = 0;
    const counting: DriveS3Access["inOwnTransaction"] = (work) => {
      wrapped += 1;
      return inOwn(work);
    };

    await expect(ensureDriveS3Folders(access(store, counting), ["reports"])).resolves.toBe("f1");
    await expect(ensureDriveS3Folders(access(store, counting), [])).resolves.toBeNull();
    expect(writes).toHaveLength(1);
    expect(wrapped).toBe(1);
  });
});

describe("driveFolderChildrenLockKey", () => {
  it("is shared by everyone writing into one folder, and per person at the My Drive root", () => {
    const ada = { orgId: "org", actorId: "ada" };
    const bo = { orgId: "org", actorId: "bo" };
    expect(driveFolderChildrenLockKey(ada, "shared-folder")).toBe(
      driveFolderChildrenLockKey(bo, "shared-folder"),
    );
    expect(driveFolderChildrenLockKey(ada, null)).not.toBe(driveFolderChildrenLockKey(bo, null));
    expect(driveFolderChildrenLockKey(ada, "shared-folder")).not.toBe(
      driveFolderChildrenLockKey({ orgId: "other-org", actorId: "ada" }, "shared-folder"),
    );
  });
});
