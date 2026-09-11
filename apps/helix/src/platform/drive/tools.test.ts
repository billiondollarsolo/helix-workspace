import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import type {
  DriveFolderCreateInput,
  DriveStore,
  FinalizeDriveUploadInput,
  PrepareDriveUploadInput,
} from "./store.js";
import { registerDriveTools } from "./tools.js";
import type {
  DriveAccessGrantRecord,
  DriveCommentRecord,
  DriveCommentRevisionRecord,
  DriveEntryRecord,
  DriveSearchHit,
  DriveUploadRecord,
  DriveVersionRecord,
} from "./types.js";
import type { DriveWorkflowRecord, DriveWorkflowStore } from "./workflows.js";
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
        .map((tool) => tool.id)
        .sort(),
    ).toEqual(
      [
        "drive.access.list",
        "drive.access.decide",
        "drive.access.remove",
        "drive.access.request",
        "drive.access.requests",
        "drive.access.update",
        "drive.copy",
        "drive.hide.set",
        "drive.comment.create",
        "drive.comment.delete",
        "drive.comment.evidence.list",
        "drive.comment.list",
        "drive.comment.reopen",
        "drive.comment.resolve",
        "drive.comment.update",
        "drive.create",
        "drive.delete",
        "drive.finalize",
        "drive.folder.move",
        "drive.lifecycle.get",
        "drive.lifecycle.set",
        "drive.link.create",
        "drive.link.list",
        "drive.link.revoke",
        "drive.list",
        "drive.move",
        "drive.quota.usage",
        "drive.rename",
        "drive.restore",
        "drive.search",
        "drive.share",
        "drive.star.set",
        "drive.trash",
        "drive.upload",
        "drive.upload.complete",
        "drive.view.get",
        "drive.view.set",
        "drive.upload.status",
        "drive.versions.list",
        "drive.versions.revert",
        "drive.workflow.create",
        "drive.workflow.list",
        "drive.workflow.transition",
      ].sort(),
    );
    expect(registry.list().find((tool) => tool.id === "drive.comment.delete")).toMatchObject({
      confirmationRequired: true,
    });
  });
  it("no drive tool ships an unknown/passthrough output schema", () => {
    const registry = createToolRegistry();
    registerDriveTools(registry, { store: new FakeDriveStore() });
    for (const tool of registry.list().filter((t) => t.id.startsWith("drive."))) {
      expect(() =>
        tool.outputSchema.parse({ __definitely_not_a_valid_output__: Symbol() as unknown }),
      ).toThrow();
    }
  });
  it("drive.list output validates against the concrete schema", async () => {
    const registry = createToolRegistry();
    registerDriveTools(registry, { store: new FakeDriveStore() });
    const listTool = registry.list().find((t) => t.id === "drive.list");
    if (listTool === undefined) throw new Error("Missing drive.list tool");
    const out = await listTool.handler({ folderId: null, includeTrashed: false, limit: 100 }, {
      actor: { id: actorId, orgId, type: "user", scopes: ["drive.read"] },
    } as never);
    expect(() => listTool.outputSchema.parse(out)).not.toThrow();
  });
  it("lets readers update only their own star and layout preferences", async () => {
    const store = new FakeDriveStore();
    const registry = createToolRegistry();
    registerDriveTools(registry, { store });
    const actor = { id: actorId, orgId, type: "user" as const, scopes: ["drive.read"] };
    await expect(
      registry.invoke("drive.star.set", { objectId, starred: true }, { actor }),
    ).resolves.toMatchObject({ ok: true, output: { metadata: { starred: true } } });
    await expect(registry.invoke("drive.view.get", {}, { actor })).resolves.toMatchObject({
      ok: true,
      output: { view: "grid" },
    });
    await expect(
      registry.invoke("drive.view.set", { view: "list" }, { actor }),
    ).resolves.toMatchObject({ ok: true, output: { view: "list" } });
    expect(store.starred[0]).toMatchObject({ orgId, actorId, objectId, starred: true });
    expect(store.documentSurfaceView).toBe("list");
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
      uploadHeaders: { "content-type": "application/pdf" },
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
  it("exposes one typed user flow for governed Drive workflows", async () => {
    const workflows = new FakeWorkflowStore();
    const registry = createToolRegistry();
    registerDriveTools(registry, {
      store: new FakeDriveStore(),
      workflows,
      resolveShareActorRefs: async ({ refs }) => ({
        actorIds: refs[0] === "reviewer@example.test" ? [folderId] : [],
        unresolvedRefs: [],
      }),
    });
    const actor = {
      id: actorId,
      orgId,
      type: "user" as const,
      scopes: ["drive.read", "drive.write"],
    };
    const created = await registry.invoke(
      "drive.workflow.create",
      {
        kind: "approval",
        resourceType: "object",
        resourceId: objectId,
        assignedToActorRef: "reviewer@example.test",
        payload: { reason: "Publish" },
      },
      { actor },
    );
    expect(created).toMatchObject({ ok: true, output: { kind: "approval", state: "open" } });
    expect(workflows.createdInput?.assignedToActorId).toBe(folderId);
    const transitioned = await registry.invoke(
      "drive.workflow.transition",
      {
        workflowId: workflows.record.id,
        expectedVersion: "1",
        state: "approved",
        payload: {},
      },
      { actor },
    );
    expect(transitioned).toMatchObject({ ok: true, output: { state: "approved", version: "2" } });
    await expect(
      registry.invoke("drive.workflow.list", { state: "approved", limit: 100 }, { actor }),
    ).resolves.toMatchObject({ ok: true, output: { workflows: [{ state: "approved" }] } });
  });
  it("passes sensitivity downgrade authority only from the security-admin permission", async () => {
    const workflows = new FakeWorkflowStore();
    const registry = createToolRegistry();
    registerDriveTools(registry, { store: new FakeDriveStore(), workflows });
    const input = {
      kind: "classification" as const,
      resourceType: "object" as const,
      resourceId: objectId,
      payload: { classification: "public" },
    };
    await registry.invoke("drive.workflow.create", input, {
      actor: {
        id: actorId,
        orgId,
        type: "user",
        scopes: ["drive.write", "admin.security"],
      },
    });
    expect(workflows.createdInput?.allowSensitivityDowngrade).toBe(true);
    await registry.invoke("drive.workflow.create", input, {
      actor: { id: actorId, orgId, type: "user", scopes: ["drive.write"] },
    });
    expect(workflows.createdInput?.allowSensitivityDowngrade).toBe(false);
  });
  it("rejects inline bytes during upload finalization", async () => {
    const store = new FakeDriveStore();
    const registry = createToolRegistry();
    registerDriveTools(registry, { store });
    const result = await registry.invoke(
      "drive.finalize",
      {
        objectId,
        byteSize: 3,
        contentBase64: Buffer.from("raw").toString("base64"),
      },
      { actor: { id: actorId, orgId, type: "user", scopes: ["drive.write"] } },
    );
    expect(result.ok).toBe(false);
    expect(store.finalized).toEqual([]);
  });
  it("rejects caller-provided finalize storage keys", async () => {
    const store = new FakeDriveStore();
    const registry = createToolRegistry();
    registerDriveTools(registry, { store });
    const result = await registry.invoke(
      "drive.finalize",
      { objectId, byteSize: 3, storageKey: "drive/untrusted" },
      { actor: { id: actorId, orgId, type: "user", scopes: ["drive.write"] } },
    );
    expect(result.ok).toBe(false);
    expect(store.finalized).toEqual([]);
  });
  it("creates, lists, and resolves Drive object comments", async () => {
    const store = new FakeDriveStore();
    const registry = createToolRegistry();
    registerDriveTools(registry, { store });
    const actor = {
      id: actorId,
      orgId,
      type: "user" as const,
      scopes: ["drive.read"],
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
      registry.invoke("drive.comment.evidence.list", { objectId, limit: 25 }, { actor }),
    ).resolves.toMatchObject({
      ok: true,
      output: {
        revisions: [{ commentId: "77777777-7777-4777-8777-777777777777", revision: 1 }],
        nextCursor: null,
      },
    });
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
    await expect(
      registry.invoke(
        "drive.share",
        {
          objectId,
          actorRefs: ["maya@helix.local"],
          role: "reader",
        },
        { actor },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: "Drive share by email or name is not configured.",
    });
    await expect(
      registry.invoke("drive.access.list", { objectId }, { actor }),
    ).resolves.toMatchObject({
      ok: true,
      output: {
        grants: [
          {
            actorId: "66666666-6666-4666-8666-666666666666",
            role: "reader",
            displayName: "Maya Chen",
            email: "maya@helix.local",
            createdAt: now.toISOString(),
          },
        ],
      },
    });
    await expect(
      registry.invoke(
        "drive.access.remove",
        { objectId, actorId: "66666666-6666-4666-8666-666666666666" },
        { actor },
      ),
    ).resolves.toMatchObject({
      ok: true,
      output: { objectId, actorId: "66666666-6666-4666-8666-666666666666", removed: true },
    });
    await expect(
      registry.invoke(
        "drive.access.update",
        { objectId, actorId: "66666666-6666-4666-8666-666666666666", role: "editor" },
        { actor },
      ),
    ).resolves.toMatchObject({
      ok: true,
      output: {
        objectId,
        actorId: "66666666-6666-4666-8666-666666666666",
        grant: {
          actorId: "66666666-6666-4666-8666-666666666666",
          role: "editor",
          displayName: "Maya Chen",
        },
      },
    });
    await expect(registry.invoke("drive.trash", { objectId }, { actor })).resolves.toMatchObject({
      ok: true,
    });
    await expect(registry.invoke("drive.restore", { objectId }, { actor })).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      registry.invoke("drive.star.set", { objectId, starred: true }, { actor }),
    ).resolves.toMatchObject({
      ok: true,
      output: { id: objectId, metadata: { starred: true } },
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
            updatedAt: now.toISOString(),
          },
        ],
      },
    });
  });
  it("resolves Drive share email/name refs before granting object access", async () => {
    const registry = createToolRegistry();
    registerDriveTools(registry, {
      store: new FakeDriveStore(),
      resolveShareActorRefs: async ({ orgId: refOrgId, refs }) => {
        expect(refOrgId).toBe(orgId);
        expect(refs).toEqual(["maya@helix.local", "Maya Chen"]);
        return {
          actorIds: [
            "66666666-6666-4666-8666-666666666666",
            "77777777-7777-4777-8777-777777777777",
          ],
          unresolvedRefs: [],
        };
      },
    });
    const actor = {
      id: actorId,
      orgId,
      type: "user" as const,
      scopes: ["drive.write"],
    };
    await expect(
      registry.invoke(
        "drive.share",
        {
          objectId,
          actorIds: ["66666666-6666-4666-8666-666666666666"],
          actorRefs: ["maya@helix.local", "Maya Chen"],
          role: "reader",
        },
        { actor },
      ),
    ).resolves.toMatchObject({
      ok: true,
      output: {
        objectId,
        sharedWithActorIds: [
          "66666666-6666-4666-8666-666666666666",
          "77777777-7777-4777-8777-777777777777",
        ],
      },
    });
  });
  it("drive.create with kind:folder creates a drive_folders row", async () => {
    const driveStore = new FakeDriveStore();
    const registry = createToolRegistry();
    registerDriveTools(registry, {
      store: driveStore,
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
  it("drive.create tool is registered in the tool list", () => {
    const registry = createToolRegistry();
    registerDriveTools(registry, {
      store: new FakeDriveStore(),
    });
    const toolIds = registry
      .list()
      .filter((tool) => tool.id.startsWith("drive."))
      .map((tool) => tool.id);
    expect(toolIds).toContain("drive.create");
  });
  it("does not advertise native authoring kinds when editor stores are disabled", async () => {
    const registry = createToolRegistry();
    registerDriveTools(registry, { store: new FakeDriveStore() });
    const create = registry.list().find((tool) => tool.id === "drive.create");
    if (create === undefined) throw new Error("Missing drive.create tool");
    expect(() =>
      create.inputSchema.parse({
        kind: "document",
        name: "Native document",
      }),
    ).toThrow();
    expect(() =>
      create.inputSchema.parse({
        kind: "folder",
        name: "Storage folder",
      }),
    ).not.toThrow();
    expect(create.description).toBe("Create a new Drive folder.");
  });
  it("drive.link.create denies public links when external sharing is blocked (ADM.6)", async () => {
    const registry = createToolRegistry();
    registerDriveTools(registry, {
      store: new FakeDriveStore(),
      getExternalSharingPolicy: async () => ({
        enabled: true,
        enforcement: "required",
        settings: { mode: "blocked", allowedDomains: [], requireExpiry: false },
      }),
    });
    const actor = {
      id: actorId,
      orgId,
      type: "user" as const,
      displayName: "Ada",
      scopes: ["drive.write"],
    };
    await expect(
      registry.invoke(
        "drive.link.create",
        { objectId, role: "reader", rateLimitPerHour: 120 },
        { actor },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/blocked/i),
    });
  });
  it("drive.link.create allows public links when external sharing mode is anyone", async () => {
    const registry = createToolRegistry();
    registerDriveTools(registry, {
      store: new FakeDriveStore(),
      getExternalSharingPolicy: async () => ({
        enabled: true,
        enforcement: "optional",
        settings: { mode: "anyone", allowedDomains: [], requireExpiry: false },
      }),
    });
    const actor = {
      id: actorId,
      orgId,
      type: "user" as const,
      displayName: "Ada",
      scopes: ["drive.write"],
    };
    await expect(
      registry.invoke(
        "drive.link.create",
        { objectId, role: "reader", rateLimitPerHour: 120 },
        { actor },
      ),
    ).resolves.toMatchObject({
      ok: true,
      output: { objectId, role: "reader" },
    });
  });
  it("drive.share denies email targets outside the external-sharing allowlist", async () => {
    const registry = createToolRegistry();
    registerDriveTools(registry, {
      store: new FakeDriveStore(),
      getExternalSharingPolicy: async () => ({
        enabled: true,
        enforcement: "required",
        settings: {
          mode: "allowlist",
          allowedDomains: ["helix.example"],
          requireExpiry: false,
        },
      }),
      resolveShareActorRefs: async () => ({
        actorIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab"],
        unresolvedRefs: [],
      }),
    });
    const actor = {
      id: actorId,
      orgId,
      type: "user" as const,
      displayName: "Ada",
      scopes: ["drive.write"],
    };
    await expect(
      registry.invoke(
        "drive.share",
        {
          objectId,
          role: "reader",
          actorIds: [],
          actorRefs: ["outsider@evil.example"],
        },
        { actor },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/denies recipient domain/i),
    });
  });
});
class FakeWorkflowStore implements DriveWorkflowStore {
  createdInput: Parameters<DriveWorkflowStore["create"]>[0] | undefined;
  record: DriveWorkflowRecord = {
    id: "99999999-9999-4999-8999-999999999999",
    kind: "approval",
    resourceType: "object",
    resourceId: objectId,
    requestedByActorId: actorId,
    assignedToActorId: folderId,
    state: "open",
    version: "1",
    payload: { reason: "Publish" },
    policySnapshot: { dlp: { action: "block" } },
    dueAt: null,
    decidedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  async create(input: Parameters<DriveWorkflowStore["create"]>[0]): Promise<DriveWorkflowRecord> {
    this.createdInput = input;
    return this.record;
  }
  async list(): Promise<readonly DriveWorkflowRecord[]> {
    return [this.record];
  }
  async transition(
    input: Parameters<DriveWorkflowStore["transition"]>[0],
  ): Promise<DriveWorkflowRecord> {
    this.record = {
      ...this.record,
      state: input.state,
      version: "2",
      decidedAt: now,
    };
    return this.record;
  }
}
class FakeDriveStore implements DriveStore {
  readonly uploads: PrepareDriveUploadInput[] = [];
  readonly finalized: FinalizeDriveUploadInput[] = [];
  readonly createdFolders: DriveFolderCreateInput[] = [];
  readonly comments: Parameters<NonNullable<DriveStore["createComment"]>>[0][] = [];
  readonly listedComments: Parameters<NonNullable<DriveStore["listComments"]>>[0][] = [];
  readonly reopenedComments: Parameters<NonNullable<DriveStore["reopenComment"]>>[0][] = [];
  readonly updatedComments: Parameters<NonNullable<DriveStore["updateComment"]>>[0][] = [];
  readonly deletedComments: Parameters<NonNullable<DriveStore["deleteComment"]>>[0][] = [];
  readonly starred: Parameters<NonNullable<DriveStore["setStarred"]>>[0][] = [];
  readonly removedAccess: Parameters<NonNullable<DriveStore["removeAccess"]>>[0][] = [];
  readonly updatedAccess: Parameters<NonNullable<DriveStore["updateAccess"]>>[0][] = [];
  documentSurfaceView: "grid" | "list" = "grid";
  async createFolder(input: DriveFolderCreateInput): Promise<DriveEntryRecord> {
    this.createdFolders.push(input);
    return {
      id: objectId,
      type: "folder",
      name: input.name,
      folderId: input.parentFolderId ?? null,
      ownerActorId: input.actorId,
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
      uploadHeaders: { "content-type": input.mimeType },
      mimeType: input.mimeType,
      byteSize: input.byteSize,
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
      storageKey: `drive/${input.orgId}/${input.objectId}/v1/report.pdf`,
      mimeType: input.mimeType ?? "application/pdf",
      byteSize: input.byteSize,
      sha256: input.sha256 ?? "0".repeat(64),
      metadata: input.metadata ?? {},
      createdByActorId: input.actorId,
      createdAt: now,
    };
  }
  async list(): ReturnType<DriveStore["list"]> {
    return { entries: [entry()], nextCursor: null };
  }
  async share(input: Parameters<DriveStore["share"]>[0]) {
    return { objectId: input.objectId, sharedWithActorIds: input.targetActorIds, role: input.role };
  }
  async listAccess(): Promise<readonly DriveAccessGrantRecord[]> {
    return [
      {
        actorId: "66666666-6666-4666-8666-666666666666",
        role: "reader",
        displayName: "Maya Chen",
        email: "maya@helix.local",
        grantedByActorId: actorId,
        expiresAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
  async removeAccess(input: Parameters<NonNullable<DriveStore["removeAccess"]>>[0]) {
    this.removedAccess.push(input);
    return true;
  }
  async updateAccess(
    input: Parameters<NonNullable<DriveStore["updateAccess"]>>[0],
  ): Promise<DriveAccessGrantRecord | null> {
    this.updatedAccess.push(input);
    return {
      actorId: input.targetActorId,
      role: input.role,
      displayName: "Maya Chen",
      email: "maya@helix.local",
      grantedByActorId: input.actorId,
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }
  async move(): Promise<DriveEntryRecord | null> {
    return entry();
  }
  async setStarred(input: Parameters<NonNullable<DriveStore["setStarred"]>>[0]) {
    this.starred.push(input);
    return { ...entry(), metadata: { ...entry().metadata, starred: input.starred } };
  }
  async getDocumentSurfaceView() {
    return this.documentSurfaceView;
  }
  async setDocumentSurfaceView(
    input: Parameters<NonNullable<DriveStore["setDocumentSurfaceView"]>>[0],
  ) {
    this.documentSurfaceView = input.view;
    return input.view;
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
        updatedAt: now,
        preview: "Report application/pdf",
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
  async listComments(input: Parameters<NonNullable<DriveStore["listComments"]>>[0]) {
    this.listedComments.push(input);
    return {
      comments: [driveComment({ body: "Review page totals", status: "open" })],
      nextCursor: null,
    };
  }
  async listCommentRevisions() {
    return {
      revisions: [driveCommentRevision()],
      nextCursor: null,
    };
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
  async rename(input: Parameters<NonNullable<DriveStore["rename"]>>[0]) {
    return { ...entry(), name: input.name };
  }
  async listVersions() {
    return [
      {
        id: versionId,
        orgId,
        objectId,
        versionNumber: 1,
        storageKey: `drive/${orgId}/${objectId}/v1/report.pdf`,
        mimeType: "application/pdf",
        byteSize: 128,
        sha256,
        metadata: {},
        createdByActorId: actorId,
        createdAt: now,
      },
    ];
  }
  async revertToVersion(input: Parameters<NonNullable<DriveStore["revertToVersion"]>>[0]) {
    return {
      id: versionId,
      orgId,
      objectId: input.objectId,
      versionNumber: input.versionNumber + 1,
      storageKey: `drive/${orgId}/${input.objectId}/v1/report.pdf`,
      mimeType: "application/pdf",
      byteSize: 128,
      sha256,
      metadata: { revertedFromVersion: input.versionNumber },
      createdByActorId: actorId,
      createdAt: now,
    };
  }
  async createShareLink(input: Parameters<NonNullable<DriveStore["createShareLink"]>>[0]) {
    return {
      id: "88888888-8888-4888-8888-888888888888",
      orgId: input.orgId,
      objectId: input.objectId,
      token: "p".repeat(43),
      role: "reader" as const,
      expiresAt: input.expiresAt ?? null,
      passwordProtected: input.password !== undefined,
      oneTime: input.oneTime ?? false,
      allowedDomains: input.allowedDomains ?? [],
      allowDownload: input.allowDownload ?? true,
      consumedAt: null,
      createdByActorId: input.actorId,
      createdAt: now,
      revokedAt: null,
      maxDownloads: input.maxDownloads ?? null,
      downloadCount: 0,
      rateLimitPerHour: input.rateLimitPerHour ?? 120,
      lastUsedAt: null,
    };
  }
  async listShareLinks() {
    return [];
  }
  async revokeShareLink() {
    return true;
  }
}
function driveComment(
  input: Partial<DriveCommentRecord> & {
    readonly body: string;
  },
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
function driveCommentRevision(): DriveCommentRevisionRecord {
  return {
    id: "88888888-8888-4888-8888-888888888888",
    orgId,
    objectId,
    commentId: "77777777-7777-4777-8777-777777777777",
    revision: 1,
    changeKind: "created",
    parentCommentId: null,
    commentActorId: actorId,
    anchor: {},
    body: "Review page totals",
    status: "open",
    metadata: {},
    resolvedAt: null,
    resolvedByActorId: null,
    deletedAt: null,
    deletedByActorId: null,
    changedByActorId: actorId,
    capturedAt: now,
  };
}
function entry(): DriveEntryRecord {
  return {
    id: objectId,
    type: "file",
    name: "report.pdf",
    folderId,
    ownerActorId: actorId,
    mimeType: "application/pdf",
    byteSize: 128,
    sha256,
    storageKey: `drive/${orgId}/${objectId}/v1/report.pdf`,
    versionNumber: 1,
    metadata: {},
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
