import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { PostgresDriveStore, type DriveStorageClient } from "./store.js";

const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL;
const appUrl = process.env.HELIX_RLS_APP_DATABASE_URL;

describe.skipIf(!adminUrl || !appUrl)("prepared uploads after destination access changes", () => {
  let admin: postgres.Sql, app: postgres.Sql;
  const orgId = randomUUID(),
    owner = randomUUID(),
    uploader = randomUUID();
  const content = Buffer.from("A private attachment to file in the shared folder.");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const as = <T>(actorId: string, fn: () => Promise<T>) =>
    withTenantPostgresContext(app, { orgId, actorId }, fn);
  beforeAll(async () => {
    assert(adminUrl && appUrl);
    admin = postgres(adminUrl, { max: 2, prepare: false });
    app = tenantAwarePostgresSql(postgres(appUrl, { max: 4, prepare: false }));
    await admin`insert into orgs(id,slug,display_name,status) values(${orgId},${orgId},'Upload revocation regression','active')`;
    for (const id of [owner, uploader])
      await admin`insert into actors(id,org_id,type,email,display_name) values(${id},${orgId},'user',${id + "@example.test"},'Upload test')`;
  });
  afterAll(async () => {
    await cleanupTestTenants(admin, [orgId]);
    await Promise.all([app.end(), admin.end()]);
  });
  async function setup(beforeScan: () => Promise<void> = async () => {}) {
    const objects = new Map<string, Uint8Array>();
    const storage: DriveStorageClient = {
      async put(input) {
        const chunks: Uint8Array[] = [];
        if (input.body instanceof Uint8Array) chunks.push(input.body);
        else for await (const chunk of input.body) chunks.push(chunk);
        objects.set(input.key, Buffer.concat(chunks));
      },
      async get(key) {
        const body = objects.get(key);
        return body ? { key, body } : null;
      },
      async delete(key) {
        objects.delete(key);
      },
    };
    const scan = vi.fn(async () => {
      await beforeScan();
      return { clean: true };
    });
    const drive = new PostgresDriveStore(app, storage, { virusScanner: { scan } });
    const folder = await as(owner, () =>
      drive.createFolder({
        orgId,
        actorId: owner,
        name: "Shared destination",
        parentFolderId: null,
      }),
    );
    await as(owner, () =>
      drive.share({
        orgId,
        actorId: owner,
        objectId: folder.id,
        targetActorIds: [uploader],
        role: "editor",
        notify: false,
      }),
    );
    const prepared = await as(uploader, () =>
      drive.prepareUpload({
        orgId,
        actorId: uploader,
        folderId: folder.id,
        name: "filed.txt",
        mimeType: "text/plain",
        byteSize: content.length,
        sha256,
      }),
    );
    const finalize = () =>
      as(uploader, () =>
        drive.finalizeUpload({
          orgId,
          actorId: uploader,
          objectId: prepared.objectId,
          byteSize: content.length,
          sha256,
          mimeType: "text/plain",
          content,
          idempotencyKey: "folder-revocation-regression",
        }),
      );
    const revoke = () =>
      as(owner, () =>
        drive.removeAccess({
          orgId,
          actorId: owner,
          objectId: folder.id,
          targetActorId: uploader,
        }),
      );
    const versions = async () => {
      const [row] =
        await admin`select count(*)::int n from drive_versions where org_id=${orgId} and object_id=${prepared.objectId}`;
      assert(row);
      return row.n;
    };
    return { drive, prepared, finalize, revoke, versions, scan };
  }
  it("denies a prepared upload before scanning when its destination grant was removed", async () => {
    const h = await setup();
    await h.revoke();
    await expect(h.finalize()).rejects.toThrow();
    expect(h.scan).not.toHaveBeenCalled();
    expect(await h.versions()).toBe(0);
    expect(
      await as(uploader, () =>
        h.drive.getUploadStatus({
          orgId,
          actorId: uploader,
          objectId: h.prepared.objectId,
        }),
      ),
    ).toMatchObject({ available: false });
  });
  it("rechecks the destination after scanning before making bytes available", async () => {
    let signalEntered!: () => void, unblock!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const h = await setup(async () => {
      signalEntered();
      await release;
    });
    const finalizing = h.finalize();
    try {
      await Promise.race([
        entered,
        finalizing.then(() => {
          throw new Error("Expected scanning to wait");
        }),
      ]);
      await h.revoke();
    } finally {
      unblock();
      await finalizing.catch(() => undefined);
    }
    await expect(finalizing).rejects.toThrow();
    expect(await h.versions()).toBe(0);
    expect(
      await as(uploader, () =>
        h.drive.getUploadStatus({
          orgId,
          actorId: uploader,
          objectId: h.prepared.objectId,
        }),
      ),
    ).toMatchObject({ available: false });
  });
  it("keeps successful filing idempotent and preserves ownership of an existing file", async () => {
    const h = await setup();
    const version = await h.finalize();
    expect(await h.finalize()).toMatchObject({ id: version.id });
    await h.revoke();
    expect(await h.finalize()).toMatchObject({ id: version.id });
    expect(await h.versions()).toBe(1);
    expect(h.scan).toHaveBeenCalledOnce();
    expect(
      await as(uploader, () =>
        h.drive.getUploadStatus({
          orgId,
          actorId: uploader,
          objectId: h.prepared.objectId,
        }),
      ),
    ).toMatchObject({ available: true });
  });
  it("also rechecks a new file after an infected verdict cleared its upload metadata", async () => {
    const h = await setup();
    h.scan.mockResolvedValueOnce({ clean: false });
    await expect(h.finalize()).rejects.toThrow();
    expect(await h.versions()).toBe(0);
    await h.revoke();
    await expect(h.finalize()).rejects.toThrow();
    expect(h.scan).toHaveBeenCalledOnce();
    expect(await h.versions()).toBe(0);
  });
});
