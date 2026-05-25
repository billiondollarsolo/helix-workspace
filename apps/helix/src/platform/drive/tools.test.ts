import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import { registerDriveTools } from "./tools.js";
import type { DriveStore, DriveFolderCreateInput, FinalizeDriveUploadInput, PrepareDriveUploadInput } from "./store.js";
import type { DriveEntryRecord, DriveSearchHit, DriveUploadRecord, DriveVersionRecord } from "./types.js";
import type { DocsStore, CreateDocsDocumentInput } from "../docs/store.js";
import type { DocsDocumentRecord } from "../docs/types.js";
import type { SheetsStore, CreateSheetInput } from "../sheets/store.js";
import type { SheetWithTabs } from "../sheets/types.js";
import type { SlidesStore, CreateSlideDeckInput } from "../slides/store.js";
import type { SlideDeckSummaryRecord } from "../slides/types.js";

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
      "drive.create",
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
  it("drive.create with kind:folder creates a drive_folders row", async () => {
    const driveStore = new FakeDriveStore();
    const registry = createToolRegistry();
    registerDriveTools(registry, {
      store: driveStore,
      docsStore: new FakeDocsStore(),
      sheetsStore: new FakeSheetsStore(),
      slidesStore: new FakeSlidesStore(),
    });
    const actor = { id: actorId, orgId, type: "user" as const, scopes: ["drive.write"] };

    const result = await registry.invoke("drive.create", {
      kind: "folder",
      name: "My Folder",
      folderId: folderId,
    }, { actor });
    expect(result.ok).toBe(true);
    expect(driveStore.createdFolders).toHaveLength(1);
    expect(driveStore.createdFolders[0]).toMatchObject({
      orgId,
      actorId,
      name: "My Folder",
      parentFolderId: folderId,
    });
    if (result.ok) {
      expect(result.output).toMatchObject({ id: objectId, type: "folder" });
    }
  });

  it("drive.create with kind:document returns { id, app:'docs' } and calls docs store", async () => {
    const docsStore = new FakeDocsStore();
    const registry = createToolRegistry();
    registerDriveTools(registry, {
      store: new FakeDriveStore(),
      docsStore,
      sheetsStore: new FakeSheetsStore(),
      slidesStore: new FakeSlidesStore(),
    });
    const actor = { id: actorId, orgId, type: "user" as const, scopes: ["drive.write"] };

    const result = await registry.invoke("drive.create", {
      kind: "document",
      name: "My Doc",
      folderId,
    }, { actor });
    expect(result.ok).toBe(true);
    expect(docsStore.created).toHaveLength(1);
    expect(docsStore.created[0]).toMatchObject({
      orgId,
      actorId,
      title: "My Doc",
      folderId,
    });
    if (result.ok) {
      expect(result.output).toMatchObject({ id: objectId, app: "docs" });
    }
  });

  it("drive.create with kind:spreadsheet returns { id, app:'sheets' } and calls sheets store", async () => {
    const sheetsStore = new FakeSheetsStore();
    const registry = createToolRegistry();
    registerDriveTools(registry, {
      store: new FakeDriveStore(),
      docsStore: new FakeDocsStore(),
      sheetsStore,
      slidesStore: new FakeSlidesStore(),
    });
    const actor = { id: actorId, orgId, type: "user" as const, scopes: ["drive.write"] };

    const result = await registry.invoke("drive.create", {
      kind: "spreadsheet",
      name: "My Sheet",
      folderId,
    }, { actor });
    expect(result.ok).toBe(true);
    expect(sheetsStore.created).toHaveLength(1);
    expect(sheetsStore.created[0]).toMatchObject({
      orgId,
      actorId,
      title: "My Sheet",
      folderId,
    });
    if (result.ok) {
      expect(result.output).toMatchObject({ id: sheetsFileId, app: "sheets" });
    }
  });

  it("drive.create with kind:presentation returns { id, app:'slides' } and calls slides store", async () => {
    const slidesStore = new FakeSlidesStore();
    const registry = createToolRegistry();
    registerDriveTools(registry, {
      store: new FakeDriveStore(),
      docsStore: new FakeDocsStore(),
      sheetsStore: new FakeSheetsStore(),
      slidesStore,
    });
    const actor = { id: actorId, orgId, type: "user" as const, scopes: ["drive.write"] };

    const result = await registry.invoke("drive.create", {
      kind: "presentation",
      name: "My Deck",
      folderId,
    }, { actor });
    expect(result.ok).toBe(true);
    expect(slidesStore.created).toHaveLength(1);
    expect(slidesStore.created[0]).toMatchObject({
      orgId,
      actorId,
      title: "My Deck",
      folderId,
    });
    if (result.ok) {
      expect(result.output).toMatchObject({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", app: "slides" });
    }
  });

  it("drive.create with kind:document and no folderId passes null folderId to docs store", async () => {
    const docsStore = new FakeDocsStore();
    const registry = createToolRegistry();
    registerDriveTools(registry, {
      store: new FakeDriveStore(),
      docsStore,
      sheetsStore: new FakeSheetsStore(),
      slidesStore: new FakeSlidesStore(),
    });
    const actor = { id: actorId, orgId, type: "user" as const, scopes: ["drive.write"] };

    const result = await registry.invoke("drive.create", {
      kind: "document",
      name: "No Folder Doc",
    }, { actor });
    expect(result.ok).toBe(true);
    expect(docsStore.created[0]).toMatchObject({ folderId: null });
  });

  it("drive.create tool is registered in the tool list", () => {
    const registry = createToolRegistry();
    registerDriveTools(registry, {
      store: new FakeDriveStore(),
      docsStore: new FakeDocsStore(),
      sheetsStore: new FakeSheetsStore(),
      slidesStore: new FakeSlidesStore(),
    });
    const toolIds = registry.list().filter((tool) => tool.id.startsWith("drive.")).map((tool) => tool.id);
    expect(toolIds).toContain("drive.create");
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
  async createFolder(): Promise<DriveEntryRecord> {
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

const deckId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

class FakeDriveStore implements DriveStore {
  readonly uploads: PrepareDriveUploadInput[] = [];
  readonly finalized: FinalizeDriveUploadInput[] = [];
  readonly createdFolders: DriveFolderCreateInput[] = [];

  async createFolder(input: DriveFolderCreateInput): Promise<DriveEntryRecord> {
    this.createdFolders.push(input);
    return {
      id: objectId,
      type: "folder",
      name: input.name,
      folderId: input.parentFolderId ?? null,
      ownerActorId: input.actorId,
      app: null,
      mimeType: "application/vnd.helix.folder",
      byteSize: 0,
      sha256: null,
      metadata: input.metadata ?? {},
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

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

class FakeDocsStore implements Pick<DocsStore, "create"> {
  readonly created: CreateDocsDocumentInput[] = [];

  async create(input: CreateDocsDocumentInput): Promise<DocsDocumentRecord> {
    this.created.push(input);
    return {
      id: objectId,
      orgId: input.orgId,
      title: input.title,
      threadId: null,
      ownerActorId: input.actorId,
      createdByActorId: input.actorId,
      ydocState: null,
      ydocStateVector: null,
      updateSeq: 0,
      editorEngine: input.editorEngine ?? "legacy-yjs",
      formatVersion: input.formatVersion ?? 1,
      metadata: { ...(input.metadata ?? {}), folderId: input.folderId ?? null },
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }
}

class FakeSheetsStore implements Pick<SheetsStore, "createSheet"> {
  readonly created: CreateSheetInput[] = [];

  async createSheet(input: CreateSheetInput): Promise<SheetWithTabs> {
    this.created.push(input);
    return {
      id: sheetsFileId,
      orgId: input.orgId,
      ownerActorId: input.actorId,
      createdByActorId: input.actorId,
      title: input.title,
      metadata: { ...(input.metadata ?? {}), app: "sheets", folderId: input.folderId ?? null },
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      tabs: [],
    };
  }
}

class FakeSlidesStore implements Pick<SlidesStore, "createDeck"> {
  readonly created: CreateSlideDeckInput[] = [];

  async createDeck(input: CreateSlideDeckInput): Promise<SlideDeckSummaryRecord> {
    this.created.push(input);
    return {
      id: deckId,
      orgId: input.orgId,
      title: input.title,
      ownerActorId: input.actorId,
      createdByActorId: input.actorId,
      metadata: { ...(input.metadata ?? {}), app: "slides", folderId: input.folderId ?? null },
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      slideCount: 0,
    };
  }
}
