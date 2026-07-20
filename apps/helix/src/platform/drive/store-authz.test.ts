import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { DriveForbiddenError, DriveNotFoundError } from "./errors.js";
import { PostgresDriveStore } from "./store.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const editorId = "33333333-3333-4333-8333-333333333333";
const readerId = "44444444-4444-4444-8444-444444444444";
const strangerId = "55555555-5555-4555-8555-555555555555";
const objectId = "66666666-6666-4666-8666-666666666666";

function objectRow(overrides: { owner?: string } = {}) {
  const now = new Date("2026-07-18T00:00:00.000Z");
  return {
    id: objectId,
    org_id: orgId,
    owner_actor_id: overrides.owner ?? ownerId,
    kind: "file",
    storage_key: "drive/test/file.bin",
    mime_type: "application/octet-stream",
    byte_size: 10,
    sha256: "a".repeat(64),
    metadata: { name: "file.bin", folderId: null, status: "ready" },
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Recording SQL that answers requireObjectAccess + role lookup.
 * Nested canReadObjectSql fragments surface the actorId; the outer select
 * uses that actor to decide visibility.
 */
function createAuthzSql(options: {
  grants: Readonly<Record<string, string>>;
  ownerId?: string;
}) {
  const owner = options.ownerId ?? ownerId;
  let lastAclActorId: string | undefined;

  const resolveActor = (values: readonly unknown[]): string | undefined => {
    for (const v of values) {
      if (typeof v === "string" && v.includes("-") && v !== objectId && v !== orgId) {
        return v;
      }
    }
    return lastAclActorId;
  };

  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");

    // Nested ACL fragment: capture actorId and return a non-promise descriptor
    // (matches store-query-shape.test.ts / store-metering.test.ts fakes).
    if (text.includes("objects.owner_actor_id") || text.includes("drive_folders.owner_actor_id")) {
      lastAclActorId = resolveActor(values) ?? lastAclActorId;
      return { text, values };
    }

    // requireObjectAccess
    if (text.includes("from objects") && text.includes("kind in")) {
      const actor = resolveActor(values);
      if (actor === undefined) return Promise.resolve([]);
      if (actor === owner || options.grants[actor] !== undefined) {
        return Promise.resolve([objectRow({ owner })]);
      }
      return Promise.resolve([]);
    }

    // requireObjectRole permission role lookup
    if (
      text.includes("from permissions") &&
      (text.includes("select role") || text.trimStart().startsWith("select role"))
    ) {
      const actor = resolveActor(values);
      if (actor === undefined || options.grants[actor] === undefined) {
        return Promise.resolve([]);
      }
      return Promise.resolve([{ role: options.grants[actor] }]);
    }

    // App trash-sync lookup
    if (text.includes("metadata->>'app'")) {
      return Promise.resolve([{ app: null }]);
    }

    // Mutations / activity after the gate
    if (text.includes("insert into permissions")) return Promise.resolve([]);
    if (text.includes("update objects")) return Promise.resolve([objectRow({ owner })]);
    if (text.includes("delete from permissions") && text.includes("removed_count")) {
      return Promise.resolve([{ removed_count: 1 }]);
    }
    if (text.includes("with target_object") || text.includes("from target_object")) {
      // updateAccess / removeAccess CTEs — return empty grant rows by default
      if (text.includes("removed_count")) return Promise.resolve([{ removed_count: 1 }]);
      return Promise.resolve([]);
    }
    if (text.includes("delete from drive_versions") || text.includes("delete from objects")) {
      return Promise.resolve([]);
    }
    if (text.includes("select storage_key") || text.includes("from drive_versions")) {
      return Promise.resolve([]);
    }
    if (text.includes("from activity") || text.includes("insert into activity")) {
      return Promise.resolve([{ hash: "0".repeat(64) }]);
    }
    if (text.includes("insert into outbox") || text.includes("from outbox")) {
      return Promise.resolve([]);
    }
    if (
      text.includes("update docs_") ||
      text.includes("update sheets") ||
      text.includes("slide_decks")
    ) {
      return Promise.resolve([]);
    }

    return Promise.resolve([]);
  };

  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
    array: (value: unknown) => value,
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
      callback(sql as unknown as postgres.TransactionSql),
  }) as unknown as postgres.Sql;

  return { sql };
}

describe("PostgresDriveStore least-privilege authz", () => {
  it("forbids a reader from sharing", async () => {
    const { sql } = createAuthzSql({ grants: { [readerId]: "reader" } });
    const store = new PostgresDriveStore(sql);
    await expect(
      store.share({
        orgId,
        actorId: readerId,
        objectId,
        targetActorIds: [editorId],
        role: "reader",
      }),
    ).rejects.toBeInstanceOf(DriveForbiddenError);
  });

  it("forbids a reader from trashing", async () => {
    const { sql } = createAuthzSql({ grants: { [readerId]: "reader" } });
    const store = new PostgresDriveStore(sql);
    await expect(store.trash({ orgId, actorId: readerId, objectId })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("forbids an editor from hard-deleting", async () => {
    const { sql } = createAuthzSql({ grants: { [editorId]: "editor" } });
    const store = new PostgresDriveStore(sql);
    await expect(store.delete({ orgId, actorId: editorId, objectId })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("forbids a reader from moving", async () => {
    const { sql } = createAuthzSql({ grants: { [readerId]: "reader" } });
    const store = new PostgresDriveStore(sql);
    await expect(
      store.move({ orgId, actorId: readerId, objectId, folderId: null }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("forbids a reader from updateAccess", async () => {
    const { sql } = createAuthzSql({ grants: { [readerId]: "reader" } });
    const store = new PostgresDriveStore(sql);
    await expect(
      store.updateAccess({
        orgId,
        actorId: readerId,
        objectId,
        targetActorId: editorId,
        role: "commenter",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("forbids a reader from removeAccess of another actor", async () => {
    const { sql } = createAuthzSql({ grants: { [readerId]: "reader" } });
    const store = new PostgresDriveStore(sql);
    await expect(
      store.removeAccess({
        orgId,
        actorId: readerId,
        objectId,
        targetActorId: editorId,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("returns not_found to a stranger with no grant", async () => {
    const { sql } = createAuthzSql({ grants: {} });
    const store = new PostgresDriveStore(sql);
    await expect(store.trash({ orgId, actorId: strangerId, objectId })).rejects.toBeInstanceOf(
      DriveNotFoundError,
    );
  });

  it("allows an editor to trash", async () => {
    const { sql } = createAuthzSql({ grants: { [editorId]: "editor" } });
    const store = new PostgresDriveStore(sql);
    await expect(store.trash({ orgId, actorId: editorId, objectId })).resolves.not.toThrow();
  });

  it("forbids a reader from restoring", async () => {
    const { sql } = createAuthzSql({ grants: { [readerId]: "reader" } });
    const store = new PostgresDriveStore(sql);
    await expect(
      store.restore({ orgId, actorId: readerId, objectId, folderId: null }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("allows the owner to share (and normalizes viewer→reader)", async () => {
    const { sql } = createAuthzSql({ grants: {} });
    const store = new PostgresDriveStore(sql);
    await expect(
      store.share({
        orgId,
        actorId: ownerId,
        objectId,
        targetActorIds: [readerId],
        role: "viewer",
      }),
    ).resolves.toMatchObject({ role: "reader" });
  });

  it("forbids a reader from renaming", async () => {
    const { sql } = createAuthzSql({ grants: { [readerId]: "reader" } });
    const store = new PostgresDriveStore(sql);
    await expect(
      store.rename({ orgId, actorId: readerId, objectId, name: "renamed.bin" }),
    ).rejects.toBeInstanceOf(DriveForbiddenError);
  });

  it("forbids a reader from reverting versions", async () => {
    const { sql } = createAuthzSql({ grants: { [readerId]: "reader" } });
    const store = new PostgresDriveStore(sql);
    await expect(
      store.revertToVersion({ orgId, actorId: readerId, objectId, versionNumber: 1 }),
    ).rejects.toBeInstanceOf(DriveForbiddenError);
  });

  it("forbids a reader from creating share links", async () => {
    const { sql } = createAuthzSql({ grants: { [readerId]: "reader" } });
    const store = new PostgresDriveStore(sql);
    await expect(
      store.createShareLink({ orgId, actorId: readerId, objectId, role: "reader" }),
    ).rejects.toBeInstanceOf(DriveForbiddenError);
  });
});
