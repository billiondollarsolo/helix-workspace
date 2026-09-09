import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { DriveForbiddenError } from "./errors.js";
import { PostgresDriveStore } from "./store.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const ownerId = "33333333-3333-4333-8333-333333333333";
const folderId = "44444444-4444-4444-8444-444444444444";

function folderRow() {
  const now = new Date("2026-09-02T00:00:00.000Z");
  return {
    id: folderId,
    org_id: orgId,
    name: "Parent",
    parent_folder_id: null,
    owner_actor_id: ownerId,
    created_by_actor_id: ownerId,
    metadata: {},
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
}

function folderSql(role: string, protectedChild = false, fileIds: readonly string[] = []) {
  const calls: string[] = [];
  const tag = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join("?");
    if (
      !/^(select|with|update|insert|delete|set)\b/iu.test(text.trimStart()) &&
      text.includes("helix_drive_effective_role")
    ) {
      return { text };
    }
    calls.push(text);
    if (text.includes("select id, owner_actor_id") && text.includes("from drive_folders")) {
      return Promise.resolve([folderRow()]);
    }
    if (text.includes("select helix_drive_effective_role")) {
      return Promise.resolve([{ role }]);
    }
    if (text.includes("permission_rank")) {
      return Promise.resolve([
        {
          owner_actor_id: ownerId,
          permission_rank: role === "owner" ? 3 : role === "editor" ? 2 : 0,
        },
      ]);
    }
    if (text.includes("insert into drive_folders")) return Promise.resolve([folderRow()]);
    if (text.includes("with recursive folder_tree") && text.includes("delete from drive_folders")) {
      return Promise.resolve(Object.assign([], { count: 1 }));
    }
    if (text.includes("with recursive folder_tree") && text.includes("delete from permissions")) {
      return Promise.resolve(Object.assign([], { count: 1 }));
    }
    if (text.includes("with recursive folder_tree") && text.includes("marked_files")) {
      return Promise.resolve([
        { file_ids: protectedChild ? [] : fileIds, root_marked: !protectedChild },
      ]);
    }
    if (text.includes("with recursive folder_tree")) {
      return Promise.resolve(
        protectedChild
          ? []
          : [{ ...folderRow(), trashed_file_ids: fileIds, restored_file_ids: fileIds }],
      );
    }
    if (text.includes("metadata->>'app'")) return Promise.resolve([{ app: "sheets" }]);
    if (text.includes("from activity") || text.includes("insert into activity")) {
      return Promise.resolve([{ hash: "0".repeat(64) }]);
    }
    return Promise.resolve([]);
  };
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
    array: (value: unknown) => value,
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
      callback(sql as unknown as postgres.TransactionSql),
  }) as unknown as postgres.Sql;
  return { sql, calls };
}

describe("Drive folder mutation authorization", () => {
  it("denies readers but lets contributors add children without delete rights", async () => {
    const reader = folderSql("reader");
    await expect(
      new PostgresDriveStore(reader.sql).createFolder({
        orgId,
        actorId,
        name: "Child",
        parentFolderId: folderId,
      }),
    ).rejects.toBeInstanceOf(DriveForbiddenError);
    expect(reader.calls.some((query) => query.includes("insert into drive_folders"))).toBe(false);

    const contributor = folderSql("commenter");
    const store = new PostgresDriveStore(contributor.sql);
    await expect(
      store.createFolder({ orgId, actorId, name: "Child", parentFolderId: folderId }),
    ).resolves.toMatchObject({ type: "folder" });
    await expect(store.trashFolder({ orgId, actorId, folderId })).rejects.toBeInstanceOf(
      DriveForbiddenError,
    );
  });

  it("atomically rejects trash when any descendant has a protected ACL boundary", async () => {
    const recording = folderSql("editor", true);
    await expect(
      new PostgresDriveStore(recording.sql).trashFolder({ orgId, actorId, folderId }),
    ).rejects.toBeInstanceOf(DriveForbiddenError);
    const trashQuery = recording.calls.find((query) =>
      query.includes("with recursive folder_tree"),
    );
    expect(trashQuery).toContain("'drive_folder', folder.id");
    expect(trashQuery).toContain("'object', object.id");
    expect(trashQuery).toContain("not exists (select 1 from unauthorized)");
  });

  it("uses one recursive lifecycle for Drive and every registered editor", async () => {
    const objectId = "55555555-5555-4555-8555-555555555555";
    const recording = folderSql("editor", false, [objectId]);
    const synced: Array<{
      app: string | null | undefined;
      action: "trash" | "restore" | "purge";
      deletedAt: Date | null;
    }> = [];
    const store = new PostgresDriveStore(recording.sql, undefined, {
      trashSync: {
        has: () => true,
        async run(app, input) {
          synced.push({ app, action: input.action, deletedAt: input.deletedAt });
        },
      },
    });

    await store.trashFolder({ orgId, actorId, folderId });
    await store.restoreFolder({ orgId, actorId, folderId });

    expect(synced).toHaveLength(2);
    expect(synced[0]).toMatchObject({ app: "sheets" });
    expect(synced[0]?.deletedAt).toBeInstanceOf(Date);
    expect(synced[1]).toEqual({ app: "sheets", action: "restore", deletedAt: null });
    const lifecycleQueries = recording.calls.filter((query) =>
      query.includes("with recursive folder_tree"),
    );
    expect(lifecycleQueries).toHaveLength(2);
    expect(lifecycleQueries.join("\n")).toContain("trashRootFolderId");
    expect(lifecycleQueries.join("\n")).not.toContain("docs_documents");
  });

  it("permanently purges a trashed folder subtree through the same Drive entry point", async () => {
    const recording = folderSql("owner");
    const store = new PostgresDriveStore(recording.sql);

    await expect(store.delete({ orgId, actorId, objectId: folderId })).resolves.toBe(true);

    const queries = recording.calls.join("\n");
    expect(queries).toContain("purgeRootFolderId");
    expect(queries).toContain("delete from drive_folders");
    expect(queries).toContain("resource_type = 'object'");
    expect(queries).toContain("helix_drive_effective_role");
  });
});
