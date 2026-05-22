import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import { registerDriveTools } from "./tools.js";
import type { DriveStore, FinalizeDriveUploadInput, PrepareDriveUploadInput } from "./store.js";
import type { DriveEntryRecord, DriveSearchHit, DriveUploadRecord, DriveVersionRecord } from "./types.js";

const plainFileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const docsFileId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sheetsFileId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const testFolderId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const now = new Date("2026-05-20T12:00:00.000Z");
const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const objectId = "33333333-3333-4333-8333-333333333333";
const folderId = "44444444-4444-4444-8444-444444444444";
const versionId = "55555555-5555-4555-8555-555555555555";
const sha256 = "a".repeat(64);

describe("drive tools", () => {
  it("registers the Phase 4 Drive tool surface", () => {
    const registry = createToolRegistry();
    registerDriveTools(registry, { store: new FakeDriveStore() });

    expect(registry.list().filter((tool) => tool.id.startsWith("drive.")).map((tool) => tool.id)).toEqual([
      "drive.delete",
      "drive.finalize",
      "drive.list",
      "drive.move",
      "drive.restore",
      "drive.search",
      "drive.share",
      "drive.trash",
      "drive.upload",
    ]);
  });

  it("prepares and finalizes uploads through the shared store contract", async () => {
    const store = new FakeDriveStore();
    const registry = createToolRegistry();
    registerDriveTools(registry, { store });
    const actor = { id: actorId, orgId, type: "user" as const, scopes: ["drive.write"] };

    const upload = await registry.invoke("drive.upload", {
      name: "report.pdf",
      folderId,
      mimeType: "application/pdf",
      byteSize: 128,
    }, { actor });
    expect(upload.ok).toBe(true);
    expect(store.uploads[0]).toMatchObject({
      orgId,
      actorId,
      name: "report.pdf",
      folderId,
      mimeType: "application/pdf",
      byteSize: 128,
    });
    expect(upload.ok ? upload.output : undefined).toMatchObject({
      objectId,
      storageKey: `drive/${orgId}/${objectId}/v1/report.pdf`,
      uploadUrl: "https://storage.example/upload",
      createdAt: now.toISOString(),
    });

    const finalized = await registry.invoke("drive.finalize", {
      objectId,
      byteSize: 128,
      sha256,
      mimeType: "application/pdf",
    }, { actor });
    expect(finalized.ok).toBe(true);
    expect(store.finalized[0]).toMatchObject({ orgId, actorId, objectId, byteSize: 128, sha256 });
    expect(finalized.ok ? finalized.output : undefined).toMatchObject({
      id: versionId,
      objectId,
      versionNumber: 1,
      createdAt: now.toISOString(),
    });
  });

  it("normalizes list, share, trash, restore, delete, and search outputs", async () => {
    const registry = createToolRegistry();
    registerDriveTools(registry, { store: new FakeDriveStore() });
    const actor = {
      id: actorId,
      orgId,
      type: "user" as const,
      scopes: ["drive.read", "drive.write", "drive.delete"],
    };

    await expect(registry.invoke("drive.list", { folderId }, { actor })).resolves.toMatchObject({
      ok: true,
      output: {
        entries: [{
          id: objectId,
          name: "report.pdf",
          preview: { kind: "pdf", status: "available", url: "https://cdn.example/report.pdf" },
          updatedAt: now.toISOString(),
        }],
      },
    });
    await expect(registry.invoke("drive.share", {
      objectId,
      actorIds: ["66666666-6666-4666-8666-666666666666"],
      role: "reader",
    }, { actor })).resolves.toMatchObject({
      ok: true,
      output: { objectId, role: "reader" },
    });
    await expect(registry.invoke("drive.trash", { objectId }, { actor })).resolves.toMatchObject({ ok: true });
    await expect(registry.invoke("drive.restore", { objectId }, { actor })).resolves.toMatchObject({ ok: true });
    await expect(registry.invoke("drive.delete", { objectId }, { actor })).resolves.toEqual({
      ok: true,
      output: { deleted: true },
    });
    await expect(registry.invoke("drive.search", { query: "report" }, { actor })).resolves.toMatchObject({
      ok: true,
      output: {
        hits: [{
          objectId,
          name: "report.pdf",
          previewMetadata: { kind: "pdf", status: "available", url: "https://cdn.example/report.pdf" },
          updatedAt: now.toISOString(),
        }],
      },
    });
  });
  it("drive.list returns app field on each entry and supports app filter", async () => {
    const registry = createToolRegistry();
    registerDriveTools(registry, { store: new AppFilterFakeDriveStore() });
    const actor = { id: actorId, orgId, type: "user" as const, scopes: ["drive.read"] };

    // No filter → all three file entries returned, each carrying their app value
    const allResult = await registry.invoke("drive.list", { folderId: testFolderId }, { actor });
    expect(allResult.ok).toBe(true);
    const allOutput = allResult.ok ? (allResult.output as { entries: DriveEntryRecord[] }) : { entries: [] };
    expect(allOutput.entries).toHaveLength(3);
    const plain = allOutput.entries.find((e) => e.id === plainFileId);
    const doc = allOutput.entries.find((e) => e.id === docsFileId);
    const sheet = allOutput.entries.find((e) => e.id === sheetsFileId);
    expect(plain?.app).toBeNull();
    expect(doc?.app).toBe("docs");
    expect(sheet?.app).toBe("sheets");

    // app: "docs" filter → only the docs entry
    const docsResult = await registry.invoke("drive.list", { folderId: testFolderId, app: "docs" }, { actor });
    expect(docsResult.ok).toBe(true);
    const docsOutput = docsResult.ok ? (docsResult.output as { entries: DriveEntryRecord[] }) : { entries: [] };
    expect(docsOutput.entries).toHaveLength(1);
    expect(docsOutput.entries[0]?.id).toBe(docsFileId);
    expect(docsOutput.entries[0]?.app).toBe("docs");
  });
});

class AppFilterFakeDriveStore implements DriveStore {
  async prepareUpload(): Promise<DriveUploadRecord> {
    throw new Error("not used");
  }
  async finalizeUpload(): Promise<DriveVersionRecord> {
    throw new Error("not used");
  }
  async list(input: Parameters<DriveStore["list"]>[0]): Promise<readonly DriveEntryRecord[]> {
    const allEntries: DriveEntryRecord[] = [
      {
        id: plainFileId,
        type: "file",
        name: "plain.txt",
        folderId: testFolderId,
        ownerActorId: actorId,
        mimeType: "text/plain",
        byteSize: 10,
        sha256: null,
        storageKey: "drive/test/plain.txt",
        app: null,
        metadata: { name: "plain.txt", folderId: testFolderId },
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: docsFileId,
        type: "file",
        name: "My Doc",
        folderId: testFolderId,
        ownerActorId: actorId,
        mimeType: "application/vnd.helix.doc",
        byteSize: 0,
        sha256: null,
        storageKey: "drive/test/doc",
        app: "docs",
        metadata: { name: "My Doc", folderId: testFolderId, app: "docs" },
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: sheetsFileId,
        type: "file",
        name: "My Sheet",
        folderId: testFolderId,
        ownerActorId: actorId,
        mimeType: "application/vnd.helix.sheet",
        byteSize: 0,
        sha256: null,
        storageKey: "drive/test/sheet",
        app: "sheets",
        metadata: { name: "My Sheet", folderId: testFolderId, app: "sheets" },
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ];
    if (input.app !== undefined && input.app !== null) {
      return allEntries.filter((e) => e.app === input.app);
    }
    return allEntries;
  }
  async share(input: Parameters<DriveStore["share"]>[0]) {
    return { objectId: input.objectId, sharedWithActorIds: input.targetActorIds, role: input.role };
  }
  async move(): Promise<DriveEntryRecord | null> { return null; }
  async trash(): Promise<DriveEntryRecord | null> { return null; }
  async restore(): Promise<DriveEntryRecord | null> { return null; }
  async delete(): Promise<boolean> { return false; }
  async search(): Promise<readonly DriveSearchHit[]> { return []; }
}

class FakeDriveStore implements DriveStore {
  readonly uploads: PrepareDriveUploadInput[] = [];
  readonly finalized: FinalizeDriveUploadInput[] = [];

  async prepareUpload(input: PrepareDriveUploadInput): Promise<DriveUploadRecord> {
    this.uploads.push(input);
    return {
      objectId,
      orgId: input.orgId,
      ownerActorId: input.actorId,
      name: input.name,
      folderId: input.folderId ?? null,
      storageKey: `drive/${input.orgId}/${objectId}/v1/${input.name}`,
      uploadUrl: "https://storage.example/upload",
      mimeType: input.mimeType,
      byteSize: input.byteSize ?? 0,
      sha256: input.sha256 ?? null,
      status: "pending_upload",
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
  }

  async finalizeUpload(input: FinalizeDriveUploadInput): Promise<DriveVersionRecord> {
    this.finalized.push(input);
    return {
      id: versionId,
      orgId: input.orgId,
      objectId: input.objectId,
      versionNumber: 1,
      storageKey: input.storageKey ?? `drive/${input.orgId}/${input.objectId}/v1/report.pdf`,
      mimeType: input.mimeType ?? "application/pdf",
      byteSize: input.byteSize,
      sha256: input.sha256,
      metadata: input.metadata ?? {},
      createdByActorId: input.actorId,
      createdAt: now,
    };
  }

  async list(): Promise<readonly DriveEntryRecord[]> {
    return [entry()];
  }

  async share(input: Parameters<DriveStore["share"]>[0]) {
    return { objectId: input.objectId, sharedWithActorIds: input.targetActorIds, role: input.role };
  }

  async move(): Promise<DriveEntryRecord | null> {
    return entry();
  }

  async trash(): Promise<DriveEntryRecord | null> {
    return { ...entry(), deletedAt: now };
  }

  async restore(): Promise<DriveEntryRecord | null> {
    return entry();
  }

  async delete(): Promise<boolean> {
    return true;
  }

  async search(): Promise<readonly DriveSearchHit[]> {
    return [{
      objectId,
      name: "report.pdf",
      mimeType: "application/pdf",
      byteSize: 128,
      sha256,
      folderId,
      preview: "report.pdf application/pdf",
      previewMetadata: {
        kind: "pdf",
        status: "available",
        mimeType: "application/pdf",
        url: "https://cdn.example/report.pdf",
      },
      updatedAt: now,
    }];
  }
}

function entry(): DriveEntryRecord {
  return {
    id: objectId,
    type: "file",
    name: "report.pdf",
    folderId,
    ownerActorId: actorId,
    app: null,
    mimeType: "application/pdf",
    byteSize: 128,
    sha256,
    storageKey: `drive/${orgId}/${objectId}/v1/report.pdf`,
    versionNumber: 1,
    preview: {
      kind: "pdf",
      status: "available",
      mimeType: "application/pdf",
      url: "https://cdn.example/report.pdf",
    },
    metadata: {
      preview: {
        kind: "pdf",
        status: "available",
        url: "https://cdn.example/report.pdf",
      },
    },
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
