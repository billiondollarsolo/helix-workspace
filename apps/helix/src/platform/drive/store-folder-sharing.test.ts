import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { DriveForbiddenError, DriveNotFoundError } from "./errors.js";
import { PostgresDriveStore } from "./store.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const granteeId = "33333333-3333-4333-8333-333333333333";
const folderId = "44444444-4444-4444-8444-444444444444";
const unknownId = "55555555-5555-4555-8555-555555555555";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function folderRow() {
  const now = new Date("2026-10-10T00:00:00.000Z");
  return {
    id: folderId,
    org_id: orgId,
    name: "Projects",
    parent_folder_id: null,
    owner_actor_id: ownerId,
    created_by_actor_id: ownerId,
    metadata: {},
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
}

function grantRow(role: string) {
  const now = new Date("2026-10-10T00:00:00.000Z");
  return {
    actor_id: granteeId,
    role,
    display_name: "Grace",
    email: "grace@example.com",
    granted_by_actor_id: ownerId,
    expires_at: null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Recording fake SQL for folder sharing. `folderExists` controls whether the
 * id resolves to a live folder; `actorRole` is the effective folder role the
 * ACL function reports for a non-owner caller.
 */
function sharingSql(options: { folderExists: boolean; actorRole: string | null }) {
  const calls: RecordedQuery[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (
      !/^(select|with|update|insert|delete|set)\b/iu.test(text.trimStart()) &&
      text.includes("helix_drive_effective_role")
    ) {
      return { text, values };
    }
    calls.push({ text, values });
    if (text.includes("delete from permissions")) {
      return Promise.resolve([{ removed_count: 1 }]);
    }
    if (text.includes("update permissions")) {
      return Promise.resolve([grantRow("editor")]);
    }
    if (text.includes("select owner_actor_id from drive_folders")) {
      return Promise.resolve(options.folderExists ? [{ owner_actor_id: ownerId }] : []);
    }
    if (text.includes("select id from drive_folders")) {
      return Promise.resolve(options.folderExists ? [{ id: folderId }] : []);
    }
    if (text.includes("select id, owner_actor_id") && text.includes("from drive_folders")) {
      return Promise.resolve(
        options.folderExists && options.actorRole !== null ? [folderRow()] : [],
      );
    }
    if (text.includes("select helix_drive_effective_role")) {
      return Promise.resolve([{ role: options.actorRole }]);
    }
    if (text.includes("update drive_folders")) {
      return Promise.resolve([{ ...folderRow(), name: "Renamed" }]);
    }
    if (text.includes("from permissions p") && text.includes("'drive_folder'")) {
      return Promise.resolve([grantRow("reader")]);
    }
    if (text.includes("insert into notifications")) {
      return Promise.resolve([
        {
          id: "99999999-9999-4999-8999-999999999999",
          payload: {},
          created_at: new Date(0),
          read_at: null,
        },
      ]);
    }
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

function activityVerbs(calls: readonly RecordedQuery[]): readonly unknown[] {
  return calls
    .filter((call) => call.text.includes("insert into activity"))
    .flatMap((call) => call.values.filter((value) => typeof value === "string"));
}

describe("Drive folder sharing", () => {
  it("writes drive_folder grants when the owner shares a folder", async () => {
    const fake = sharingSql({ folderExists: true, actorRole: "owner" });
    await expect(
      new PostgresDriveStore(fake.sql).share({
        orgId,
        actorId: ownerId,
        objectId: folderId,
        targetActorIds: [granteeId],
        role: "reader",
      }),
    ).resolves.toMatchObject({ objectId: folderId, sharedWithActorIds: [granteeId] });
    const insert = fake.calls.find((call) => call.text.includes("insert into permissions"));
    expect(insert?.values).toContain("drive_folder");
    expect(insert?.values).not.toContain("object");
    expect(activityVerbs(fake.calls)).toContain("drive.folder.shared");
  });

  it("refuses folder sharing by a non-owner", async () => {
    const fake = sharingSql({ folderExists: true, actorRole: "editor" });
    await expect(
      new PostgresDriveStore(fake.sql).share({
        orgId,
        actorId: granteeId,
        objectId: folderId,
        targetActorIds: [ownerId],
        role: "reader",
      }),
    ).rejects.toBeInstanceOf(DriveForbiddenError);
    expect(fake.calls.some((call) => call.text.includes("insert into permissions"))).toBe(false);
  });

  it("lists folder grants from drive_folder permissions", async () => {
    const fake = sharingSql({ folderExists: true, actorRole: "reader" });
    const grants = await new PostgresDriveStore(fake.sql).listAccess({
      orgId,
      actorId: granteeId,
      objectId: folderId,
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ actorId: granteeId, role: "reader" });
    const listQuery = fake.calls.find((call) => call.text.includes("from permissions p"));
    expect(listQuery?.text).toContain("p.resource_type = 'drive_folder'");
  });

  it("lets the owner remove a folder grant", async () => {
    const fake = sharingSql({ folderExists: true, actorRole: "owner" });
    await expect(
      new PostgresDriveStore(fake.sql).removeAccess({
        orgId,
        actorId: ownerId,
        objectId: folderId,
        targetActorId: granteeId,
      }),
    ).resolves.toBe(true);
    const deletion = fake.calls.find((call) => call.text.includes("delete from permissions"));
    expect(deletion?.text).toContain("p.resource_type = 'drive_folder'");
    expect(deletion?.text).toContain("p.source_group_grant_id is null");
    expect(deletion?.text).not.toContain("from objects");
    expect(deletion?.text).toContain("'drive_folder', f.id");
    expect(activityVerbs(fake.calls)).toContain("drive.folder.access_removed");
  });

  it("refuses removing someone else's folder grant without owner access", async () => {
    const fake = sharingSql({ folderExists: true, actorRole: "editor" });
    await expect(
      new PostgresDriveStore(fake.sql).removeAccess({
        orgId,
        actorId: granteeId,
        objectId: folderId,
        targetActorId: unknownId,
      }),
    ).rejects.toBeInstanceOf(DriveForbiddenError);
    expect(fake.calls.some((call) => call.text.includes("delete from permissions"))).toBe(false);
  });

  it("lets a grantee leave a shared folder", async () => {
    const fake = sharingSql({ folderExists: true, actorRole: "reader" });
    await expect(
      new PostgresDriveStore(fake.sql).removeAccess({
        orgId,
        actorId: granteeId,
        objectId: folderId,
        targetActorId: granteeId,
      }),
    ).resolves.toBe(true);
  });

  it("lets the owner change a folder grant's role", async () => {
    const fake = sharingSql({ folderExists: true, actorRole: "owner" });
    await expect(
      new PostgresDriveStore(fake.sql).updateAccess({
        orgId,
        actorId: ownerId,
        objectId: folderId,
        targetActorId: granteeId,
        role: "editor",
      }),
    ).resolves.toMatchObject({ actorId: granteeId, role: "editor" });
    const update = fake.calls.find((call) => call.text.includes("update permissions"));
    expect(update?.text).toContain("p.resource_type = 'drive_folder'");
    expect(update?.text).toContain("p.source_group_grant_id is null");
    expect(activityVerbs(fake.calls)).toContain("drive.folder.access_updated");
  });

  it("refuses folder role changes by a non-owner", async () => {
    const fake = sharingSql({ folderExists: true, actorRole: "editor" });
    await expect(
      new PostgresDriveStore(fake.sql).updateAccess({
        orgId,
        actorId: granteeId,
        objectId: folderId,
        targetActorId: unknownId,
        role: "editor",
      }),
    ).rejects.toBeInstanceOf(DriveForbiddenError);
    expect(fake.calls.some((call) => call.text.includes("update permissions"))).toBe(false);
  });
});

describe("Drive rename", () => {
  it("renames a folder when the caller can edit it", async () => {
    const fake = sharingSql({ folderExists: true, actorRole: "editor" });
    await expect(
      new PostgresDriveStore(fake.sql).rename({
        orgId,
        actorId: granteeId,
        objectId: folderId,
        name: "  Renamed  ",
      }),
    ).resolves.toMatchObject({ id: folderId, type: "folder", name: "Renamed" });
    const update = fake.calls.find((call) => call.text.includes("update drive_folders"));
    expect(update?.values).toContain("Renamed");
    expect(fake.calls.some((call) => call.text.includes("update objects"))).toBe(false);
    expect(activityVerbs(fake.calls)).toContain("drive.folder.renamed");
  });

  it("refuses folder rename by a reader", async () => {
    const fake = sharingSql({ folderExists: true, actorRole: "reader" });
    await expect(
      new PostgresDriveStore(fake.sql).rename({
        orgId,
        actorId: granteeId,
        objectId: folderId,
        name: "Renamed",
      }),
    ).rejects.toBeInstanceOf(DriveForbiddenError);
    expect(fake.calls.some((call) => call.text.includes("update drive_folders"))).toBe(false);
  });

  it("reports an unknown file instead of an unknown folder", async () => {
    const fake = sharingSql({ folderExists: false, actorRole: null });
    const failure = new PostgresDriveStore(fake.sql).rename({
      orgId,
      actorId: granteeId,
      objectId: unknownId,
      name: "Renamed",
    });
    await expect(failure).rejects.toBeInstanceOf(DriveNotFoundError);
    await expect(failure).rejects.not.toThrow(/folder/iu);
    expect(fake.calls.some((call) => call.text.includes("update"))).toBe(false);
  });
});
