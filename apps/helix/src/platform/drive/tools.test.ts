import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import { registerDriveTools } from "./tools.js";
import type {
  DriveStore,
  DriveFolderCreateInput,
  FinalizeDriveUploadInput,
  PrepareDriveUploadInput,
} from "./store.js";
import type {
  DriveCommentRecord,
  DriveEntryRecord,
  DrivePdfFormStateRecord,
  DriveSearchHit,
  DriveUploadRecord,
  DriveVersionRecord,
} from "./types.js";
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

    expect(
      registry
        .list()
        .filter((tool) => tool.id.startsWith("drive."))
        .map((tool) => tool.id),
    ).toEqual([
      "drive.comment.create",
      "drive.comment.delete",
      "drive.comment.list",
      "drive.comment.reopen",
      "drive.comment.resolve",
      "drive.comment.update",
      "drive.create",
      "drive.delete",
      "drive.finalize",
      "drive.list",
      "drive.move",
      "drive.pdfFormState.clear",
      "drive.pdfFormState.get",
      "drive.pdfFormState.save",
      "drive.restore",
      "drive.search",
      "drive.share",
      "drive.trash",
      "drive.upload",
    ]);
    expect(registry.list().find((tool) => tool.id === "drive.comment.delete")).toMatchObject({
      confirmationRequired: true,
    });
  });

  it("prepares and finalizes uploads through the shared store contract", async () => {
    const store = new FakeDriveStore();
    const registry = createToolRegistry();
    registerDriveTools(registry, { store });
    const actor = { id: actorId, orgId, type: "user" as const, scopes: ["drive.write"] };

    const upload = await registry.invoke(
      "drive.upload",
      {
        name: "report.pdf",
        folderId,
        mimeType: "application/pdf",
        byteSize: 128,
      },
      { actor },
    );
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

    const finalized = await registry.invoke(
      "drive.finalize",
      {
        objectId,
        byteSize: 128,
        sha256,
        mimeType: "application/pdf",
      },
      { actor },
    );
    expect(finalized.ok).toBe(true);
    expect(store.finalized[0]).toMatchObject({ orgId, actorId, objectId, byteSize: 128, sha256 });
    expect(finalized.ok ? finalized.output : undefined).toMatchObject({
      id: versionId,
      objectId,
      versionNumber: 1,
      createdAt: now.toISOString(),
    });
  });

  it("creates, lists, and resolves Drive object comments", async () => {
    const store = new FakeDriveStore();
    const registry = createToolRegistry();
    registerDriveTools(registry, { store });
    const actor = {
      id: actorId,
      orgId,
      type: "user" as const,
      scopes: ["drive.read", "drive.write"],
    };

    await expect(
      registry.invoke(
        "drive.comment.create",
        {
          objectId,
          body: "Review page totals",
          anchor: { kind: "pdf-page", page: 2, pageCount: 3, target: "page" },
          metadata: { source: "native-pdf-viewer" },
        },
        { actor },
      ),
    ).resolves.toMatchObject({
      ok: true,
      output: {
        objectId,
        body: "Review page totals",
        anchor: { kind: "pdf-page", page: 2 },
        status: "open",
        createdAt: now.toISOString(),
      },
    });
    expect(store.comments[0]).toMatchObject({
      orgId,
      actorId,
      objectId,
      body: "Review page totals",
    });
    expect(store.comments[0]?.anchor).toEqual({
      kind: "pdf-page",
      page: 2,
      pageCount: 3,
      target: "page",
    });

    await expect(
      registry.invoke(
        "drive.comment.create",
        {
          objectId,
          body: "Pin the margin note",
          anchor: {
            kind: "pdf-page-point",
            page: 2,
            pageCount: 3,
            target: "point",
            units: "percent",
            x: 25,
            y: 50,
          },
        },
        { actor },
      ),
    ).resolves.toMatchObject({
      ok: true,
      output: {
        body: "Pin the margin note",
        anchor: {
          kind: "pdf-page-point",
          page: 2,
          pageCount: 3,
          target: "point",
          units: "percent",
          x: 25,
          y: 50,
        },
      },
    });

    await expect(
      registry.invoke("drive.comment.list", { objectId, status: "open" }, { actor }),
    ).resolves.toMatchObject({
      ok: true,
      output: { comments: [{ objectId, body: "Review page totals", status: "open" }] },
    });
    expect(store.listedComments[0]).toMatchObject({ orgId, actorId, objectId, status: "open" });

    await expect(
      registry.invoke(
        "drive.comment.resolve",
        { commentId: "77777777-7777-4777-8777-777777777777" },
        { actor },
      ),
    ).resolves.toMatchObject({
      ok: true,
      output: { status: "resolved", resolvedAt: now.toISOString() },
    });

    await expect(
      registry.invoke(
        "drive.comment.update",
        { commentId: "77777777-7777-4777-8777-777777777777", body: "Updated totals" },
        { actor },
      ),
    ).resolves.toMatchObject({
      ok: true,
      output: { body: "Updated totals", status: "open" },
    });
    expect(store.updatedComments[0]).toMatchObject({
      orgId,
      actorId,
      commentId: "77777777-7777-4777-8777-777777777777",
      body: "Updated totals",
    });

    await expect(
      registry.invoke(
        "drive.comment.reopen",
        { commentId: "77777777-7777-4777-8777-777777777777" },
        { actor },
      ),
    ).resolves.toMatchObject({
      ok: true,
      output: { status: "open", resolvedAt: null },
    });
    expect(store.reopenedComments[0]).toMatchObject({
      orgId,
      actorId,
      commentId: "77777777-7777-4777-8777-777777777777",
    });

    await expect(
      registry.invoke(
        "drive.comment.delete",
        { commentId: "77777777-7777-4777-8777-777777777777" },
        { actor },
      ),
    ).resolves.toMatchObject({
      ok: true,
      output: { id: "77777777-7777-4777-8777-777777777777" },
    });
    expect(store.deletedComments[0]).toMatchObject({
      orgId,
      actorId,
      commentId: "77777777-7777-4777-8777-777777777777",
    });
  });

  it("gets, saves, and clears actor-scoped PDF form state", async () => {
    const store = new FakeDriveStore();
    const registry = createToolRegistry();
    registerDriveTools(registry, { store });
    const actor = {
      id: actorId,
      orgId,
      type: "user" as const,
      scopes: ["drive.read", "drive.write"],
    };

    await expect(
      registry.invoke("drive.pdfFormState.get", { objectId }, { actor }),
    ).resolves.toMatchObject({
      ok: true,
      output: { state: null },
    });
    expect(store.requestedPdfFormStates[0]).toMatchObject({ orgId, actorId, objectId });

    await expect(
      registry.invoke(
        "drive.pdfFormState.save",
        {
          objectId,
          fields: [
            { name: "customer_name", type: "text", value: "Northwind" },
            { name: "approved", type: "checkbox", value: true },
            { name: "signer", type: "signature", value: "Ada Lovelace" },
          ],
        },
        { actor },
      ),
    ).resolves.toMatchObject({
      ok: true,
      output: {
        objectId,
        actorId,
        fieldValues: [
          { name: "customer_name", type: "text", value: "Northwind" },
          { name: "approved", type: "checkbox", value: true },
          { name: "signer", type: "signature", value: "Ada Lovelace" },
        ],
        sourceVersionNumber: 3,
        sourceSha256: sha256,
        sourceChanged: false,
        updatedAt: now.toISOString(),
      },
    });
    expect(store.savedPdfFormStates[0]).toMatchObject({
      orgId,
      actorId,
      objectId,
      fieldValues: [
        { name: "customer_name", type: "text", value: "Northwind" },
        { name: "approved", type: "checkbox", value: true },
        { name: "signer", type: "signature", value: "Ada Lovelace" },
      ],
    });

    await expect(
      registry.invoke("drive.pdfFormState.get", { objectId }, { actor }),
    ).resolves.toMatchObject({
      ok: true,
      output: {
        state: {
          objectId,
          actorId,
          fieldValues: [
            { name: "customer_name", type: "text", value: "Northwind" },
            { name: "approved", type: "checkbox", value: true },
            { name: "signer", type: "signature", value: "Ada Lovelace" },
          ],
        },
      },
    });

    await expect(
      registry.invoke("drive.pdfFormState.clear", { objectId }, { actor }),
    ).resolves.toMatchObject({
      ok: true,
      output: { objectId, cleared: true },
    });
    expect(store.clearedPdfFormStates[0]).toMatchObject({ orgId, actorId, objectId });
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
        entries: [
          {
            id: objectId,
            name: "report.pdf",
            preview: { kind: "pdf", status: "available", url: "https://cdn.example/report.pdf" },
            updatedAt: now.toISOString(),
          },
        ],
      },
    });
    await expect(
      registry.invoke(
        "drive.share",
        {
          objectId,
          actorIds: ["66666666-6666-4666-8666-666666666666"],
          role: "reader",
        },
        { actor },
      ),
    ).resolves.toMatchObject({
      ok: true,
      output: { objectId, role: "reader" },
    });
    await expect(registry.invoke("drive.trash", { objectId }, { actor })).resolves.toMatchObject({
      ok: true,
    });
    await expect(registry.invoke("drive.restore", { objectId }, { actor })).resolves.toMatchObject({
      ok: true,
    });
    await expect(registry.invoke("drive.delete", { objectId }, { actor })).resolves.toEqual({
      ok: true,
      output: { deleted: true },
    });
    await expect(
      registry.invoke("drive.search", { query: "report" }, { actor }),
    ).resolves.toMatchObject({
      ok: true,
      output: {
        hits: [
          {
            objectId,
            name: "report.pdf",
            previewMetadata: {
              kind: "pdf",
              status: "available",
              url: "https://cdn.example/report.pdf",
            },
            updatedAt: now.toISOString(),
          },
        ],
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

    const result = await registry.invoke(
      "drive.create",
      {
        kind: "folder",
        name: "My Folder",
        folderId: folderId,
      },
      { actor },
    );
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

    const result = await registry.invoke(
      "drive.create",
      {
        kind: "document",
        name: "My Doc",
        folderId,
      },
      { actor },
    );
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

    const result = await registry.invoke(
      "drive.create",
      {
        kind: "spreadsheet",
        name: "My Sheet",
        folderId,
      },
      { actor },
    );
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

    const result = await registry.invoke(
      "drive.create",
      {
        kind: "presentation",
        name: "My Deck",
        folderId,
      },
      { actor },
    );
    expect(result.ok).toBe(true);
    expect(slidesStore.created).toHaveLength(1);
    expect(slidesStore.created[0]).toMatchObject({
      orgId,
      actorId,
      title: "My Deck",
      folderId,
    });
    if (result.ok) {
      expect(result.output).toMatchObject({
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        app: "slides",
      });
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

    const result = await registry.invoke(
      "drive.create",
      {
        kind: "document",
        name: "No Folder Doc",
      },
      { actor },
    );
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
    const toolIds = registry
      .list()
      .filter((tool) => tool.id.startsWith("drive."))
      .map((tool) => tool.id);
    expect(toolIds).toContain("drive.create");
  });

  it("drive.list returns app field on each entry and supports app filter", async () => {
    const registry = createToolRegistry();
    registerDriveTools(registry, { store: new AppFilterFakeDriveStore() });
    const actor = { id: actorId, orgId, type: "user" as const, scopes: ["drive.read"] };

    // No filter → all three file entries returned, each carrying their app value
    const allResult = await registry.invoke("drive.list", { folderId: testFolderId }, { actor });
    expect(allResult.ok).toBe(true);
    const allOutput = allResult.ok
      ? (allResult.output as { entries: DriveEntryRecord[] })
      : { entries: [] };
    expect(allOutput.entries).toHaveLength(3);
    const plain = allOutput.entries.find((e) => e.id === plainFileId);
    const doc = allOutput.entries.find((e) => e.id === docsFileId);
    const sheet = allOutput.entries.find((e) => e.id === sheetsFileId);
    expect(plain?.app).toBeNull();
    expect(doc?.app).toBe("docs");
    expect(sheet?.app).toBe("sheets");

    // app: "docs" filter → only the docs entry
    const docsResult = await registry.invoke(
      "drive.list",
      { folderId: testFolderId, app: "docs" },
      { actor },
    );
    expect(docsResult.ok).toBe(true);
    const docsOutput = docsResult.ok
      ? (docsResult.output as { entries: DriveEntryRecord[] })
      : { entries: [] };
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
  async move(): Promise<DriveEntryRecord | null> {
    return null;
  }
  async trash(): Promise<DriveEntryRecord | null> {
    return null;
  }
  async restore(): Promise<DriveEntryRecord | null> {
    return null;
  }
  async delete(): Promise<boolean> {
    return false;
  }
  async search(): Promise<readonly DriveSearchHit[]> {
    return [];
  }
}

const deckId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

class FakeDriveStore implements DriveStore {
  readonly uploads: PrepareDriveUploadInput[] = [];
  readonly finalized: FinalizeDriveUploadInput[] = [];
  readonly createdFolders: DriveFolderCreateInput[] = [];
  readonly comments: Parameters<NonNullable<DriveStore["createComment"]>>[0][] = [];
  readonly listedComments: Parameters<NonNullable<DriveStore["listComments"]>>[0][] = [];
  readonly reopenedComments: Parameters<NonNullable<DriveStore["reopenComment"]>>[0][] = [];
  readonly updatedComments: Parameters<NonNullable<DriveStore["updateComment"]>>[0][] = [];
  readonly deletedComments: Parameters<NonNullable<DriveStore["deleteComment"]>>[0][] = [];
  readonly requestedPdfFormStates: Parameters<NonNullable<DriveStore["getPdfFormState"]>>[0][] = [];
  readonly savedPdfFormStates: Parameters<NonNullable<DriveStore["savePdfFormState"]>>[0][] = [];
  readonly clearedPdfFormStates: Parameters<NonNullable<DriveStore["clearPdfFormState"]>>[0][] = [];
  pdfFormState: DrivePdfFormStateRecord | null = null;

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
    return [
      {
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
      },
    ];
  }

  async createComment(
    input: Parameters<NonNullable<DriveStore["createComment"]>>[0],
  ): Promise<DriveCommentRecord> {
    this.comments.push(input);
    return driveComment({
      body: input.body,
      anchor: input.anchor ?? {},
      metadata: input.metadata ?? {},
      parentCommentId: input.parentCommentId ?? null,
      status: "open",
    });
  }

  async listComments(
    input: Parameters<NonNullable<DriveStore["listComments"]>>[0],
  ): Promise<readonly DriveCommentRecord[]> {
    this.listedComments.push(input);
    return [driveComment({ body: "Review page totals", status: "open" })];
  }

  async resolveComment(): Promise<DriveCommentRecord | null> {
    return driveComment({
      body: "Review page totals",
      status: "resolved",
      resolvedAt: now,
    });
  }

  async reopenComment(
    input: Parameters<NonNullable<DriveStore["reopenComment"]>>[0],
  ): Promise<DriveCommentRecord | null> {
    this.reopenedComments.push(input);
    return driveComment({ body: "Review page totals", status: "open", resolvedAt: null });
  }

  async updateComment(
    input: Parameters<NonNullable<DriveStore["updateComment"]>>[0],
  ): Promise<DriveCommentRecord | null> {
    this.updatedComments.push(input);
    return driveComment({ body: input.body, status: "open" });
  }

  async deleteComment(
    input: Parameters<NonNullable<DriveStore["deleteComment"]>>[0],
  ): Promise<DriveCommentRecord | null> {
    this.deletedComments.push(input);
    return driveComment({ body: "Review page totals", status: "open" });
  }

  async getPdfFormState(
    input: Parameters<NonNullable<DriveStore["getPdfFormState"]>>[0],
  ): Promise<DrivePdfFormStateRecord | null> {
    this.requestedPdfFormStates.push(input);
    return this.pdfFormState;
  }

  async savePdfFormState(
    input: Parameters<NonNullable<DriveStore["savePdfFormState"]>>[0],
  ): Promise<DrivePdfFormStateRecord> {
    this.savedPdfFormStates.push(input);
    this.pdfFormState = pdfFormState({ fieldValues: input.fieldValues });
    return this.pdfFormState;
  }

  async clearPdfFormState(
    input: Parameters<NonNullable<DriveStore["clearPdfFormState"]>>[0],
  ): Promise<boolean> {
    this.clearedPdfFormStates.push(input);
    const cleared = this.pdfFormState !== null;
    this.pdfFormState = null;
    return cleared;
  }
}

function pdfFormState(input: {
  readonly fieldValues: readonly DrivePdfFormStateRecord["fieldValues"][number][];
}): DrivePdfFormStateRecord {
  return {
    orgId,
    objectId,
    actorId,
    fieldValues: input.fieldValues,
    sourceVersionNumber: 3,
    sourceSha256: sha256,
    sourceByteSize: 128,
    sourceChanged: false,
    createdAt: now,
    updatedAt: now,
  };
}

function driveComment(
  input: Partial<DriveCommentRecord> & { readonly body: string },
): DriveCommentRecord {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    orgId,
    objectId,
    parentCommentId: input.parentCommentId ?? null,
    actorId,
    anchor: input.anchor ?? { kind: "pdf-page", page: 2, pageCount: 3, target: "page" },
    body: input.body,
    status: input.status ?? "open",
    metadata: input.metadata ?? {},
    resolvedAt: input.resolvedAt ?? null,
    createdAt: now,
    updatedAt: input.updatedAt ?? null,
  };
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
