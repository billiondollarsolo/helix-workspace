import { describe, expect, it } from "vitest";
import type {
  JsonObject,
  MeteringClient,
  MeteringEmitInput,
  MeteringEvent,
  TraceContext,
} from "@helix/sdk-types";
import { createToolRegistry } from "../tool-registry.js";
import { InMemoryTenantHourlyQuotaLimiter } from "../limits/index.js";
import type { CreateDocsDocumentInput, NativeDocumentLayoutSettings } from "./store.js";
import { HELIX_NATIVE_DOCUMENT_ENGINE } from "./native-state.js";
import { createDocsToolDefinitions, registerDocsTools } from "./tools.js";
import type {
  DocsCommentListItem,
  DocsCommentRecord,
  DocsDocumentRecord,
  DocsExportDocument,
  DocsExportResult,
  DocsUpdateRecord,
  DocsVersionPreviewRecord,
  DocsVersionRestoreRecord,
} from "./types.js";

const now = new Date("2026-05-20T12:00:00.000Z");
const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const docId = "33333333-3333-4333-8333-333333333333";

describe("docs tools", () => {
  it("passes explicit native editor options through docs.create", async () => {
    const store = new FakeDocsStore();
    const registry = createToolRegistry();
    registerDocsTools(registry, { store });

    const result = await registry.invoke(
      "docs.create",
      {
        title: "Native doc",
        initialMarkdown: "# Native doc\n",
        editorEngine: HELIX_NATIVE_DOCUMENT_ENGINE,
        formatVersion: 1,
        metadata: { createdFrom: "test" },
      },
      { actor: { id: actorId, orgId, type: "user", scopes: ["docs.write"] } },
    );

    expect(result.ok).toBe(true);
    expect(store.created[0]).toMatchObject({
      orgId,
      actorId,
      title: "Native doc",
      initialMarkdown: "# Native doc\n",
      editorEngine: HELIX_NATIVE_DOCUMENT_ENGINE,
      formatVersion: 1,
      folderId: null,
      metadata: { createdFrom: "test" },
    });
    expect(result.ok ? result.output : undefined).toMatchObject({
      id: docId,
      title: "Native doc",
      editorEngine: HELIX_NATIVE_DOCUMENT_ENGINE,
      formatVersion: 1,
    });
  });

  it("keeps docs.create backward-compatible when no editor engine is provided", async () => {
    const store = new FakeDocsStore();
    const registry = createToolRegistry();
    registerDocsTools(registry, { store });

    const result = await registry.invoke(
      "docs.create",
      { title: "Legacy default" },
      { actor: { id: actorId, orgId, type: "user", scopes: ["docs.write"] } },
    );

    expect(result.ok).toBe(true);
    expect(store.created[0]).not.toHaveProperty("editorEngine");
    expect(store.created[0]).not.toHaveProperty("formatVersion");
  });

  it("updates native document layout settings through docs.update-layout", async () => {
    const store = new FakeDocsStore();
    const registry = createToolRegistry();
    registerDocsTools(registry, { store });

    const result = await registry.invoke(
      "docs.update-layout",
      {
        docId,
        layoutSettings: {
          layoutMode: "pageless",
          columnCount: 2,
          sections: [
            {
              id: "default",
              title: "Document",
              layoutMode: "pageless",
              columnCount: 2,
              pageSize: "a4",
              orientation: "landscape",
            },
          ],
        },
      },
      { actor: { id: actorId, orgId, type: "user", scopes: ["docs.write"] } },
    );

    expect(result.ok).toBe(true);
    expect(store.layoutUpdates).toEqual([
      {
        orgId,
        actorId,
        documentId: docId,
        layoutSettings: {
          layoutMode: "pageless",
          columnCount: 2,
          sections: [
            {
              id: "default",
              title: "Document",
              layoutMode: "pageless",
              columnCount: 2,
              pageSize: "a4",
              orientation: "landscape",
            },
          ],
        },
      },
    ]);
    expect(result.ok ? result.output : undefined).toMatchObject({
      id: docId,
      metadata: {
        nativeDocumentLayout: {
          layoutMode: "pageless",
          columnCount: 2,
          sections: [
            {
              id: "default",
              title: "Document",
              layoutMode: "pageless",
              columnCount: 2,
              pageSize: "a4",
              orientation: "landscape",
            },
          ],
        },
      },
    });
  });

  it("migrates legacy Docs documents into the native editor engine", async () => {
    const store = new FakeDocsStore();
    const registry = createToolRegistry();
    registerDocsTools(registry, { store });

    const result = await registry.invoke(
      "docs.migrate-native",
      { docId },
      { actor: { id: actorId, orgId, type: "user", scopes: ["docs.write"] } },
    );

    expect(result.ok).toBe(true);
    expect(store.nativeMigrations).toEqual([
      {
        orgId,
        actorId,
        documentId: docId,
      },
    ]);
    expect(result.ok ? result.output : undefined).toMatchObject({
      id: docId,
      editorEngine: HELIX_NATIVE_DOCUMENT_ENGINE,
      formatVersion: 1,
    });
  });

  it("imports DOCX bytes into a native Docs document", async () => {
    const store = new FakeDocsStore();
    const registry = createToolRegistry();
    registerDocsTools(registry, {
      store,
      docxToMarkdown: async (input) => ({
        markdown: `# Imported\n\nBytes: ${String(input.buffer.byteLength)}`,
        messages: [{ type: "warning", message: "Dropped unsupported shape" }],
      }),
    });

    const result = await registry.invoke(
      "docs.import-docx",
      {
        filename: "Launch Plan.docx",
        contentBase64: Buffer.from("docx bytes", "utf8").toString("base64"),
        metadata: { source: "test" },
      },
      { actor: { id: actorId, orgId, type: "user", scopes: ["docs.write"] } },
    );

    expect(result.ok).toBe(true);
    expect(store.created[0]).toMatchObject({
      orgId,
      actorId,
      title: "Launch Plan",
      initialMarkdown: "# Imported\n\nBytes: 10",
      editorEngine: HELIX_NATIVE_DOCUMENT_ENGINE,
      formatVersion: 1,
      folderId: null,
      metadata: {
        source: "test",
        importedFrom: "docx",
        filename: "Launch Plan.docx",
        importMessages: [{ type: "warning", message: "Dropped unsupported shape" }],
      },
    });
    expect(result.ok ? result.output : undefined).toMatchObject({
      id: docId,
      title: "Launch Plan",
      editorEngine: HELIX_NATIVE_DOCUMENT_ENGINE,
      formatVersion: 1,
    });
  });

  it("lists comments through docs.comment.list with access-scoped input", async () => {
    const store = new FakeDocsStore();
    const registry = createToolRegistry();
    registerDocsTools(registry, { store });

    const result = await registry.invoke(
      "docs.comment.list",
      { docId },
      { actor: { id: actorId, orgId, type: "user", scopes: ["docs.read"] } },
    );

    expect(result.ok).toBe(true);
    expect(store.commentLists).toEqual([
      {
        orgId,
        actorId,
        documentId: docId,
        status: "open",
      },
    ]);
    expect(result.ok ? result.output : undefined).toMatchObject({
      comments: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          documentId: docId,
          body: "Needs owner",
          status: "open",
          author: { displayName: "Ada", email: "ada@example.test" },
          createdAt: now.toISOString(),
        },
      ],
    });
  });

  it("creates threaded comment replies through docs.comment.create", async () => {
    const store = new FakeDocsStore();
    const registry = createToolRegistry();
    registerDocsTools(registry, { store });
    const parentCommentId = "55555555-5555-4555-8555-555555555555";

    const result = await registry.invoke(
      "docs.comment.create",
      {
        docId,
        parentCommentId,
        body: "Reply with follow-up",
        anchor: { kind: "document" },
        metadata: { source: "test" },
      },
      { actor: { id: actorId, orgId, type: "user", scopes: ["docs.comment"] } },
    );

    expect(result.ok).toBe(true);
    expect(store.commentCreations).toEqual([
      {
        orgId,
        actorId,
        documentId: docId,
        parentCommentId,
        body: "Reply with follow-up",
        anchor: { kind: "document" },
        metadata: { source: "test" },
      },
    ]);
    expect(result.ok ? result.output : undefined).toMatchObject({
      parentCommentId,
      body: "Reply with follow-up",
    });
  });

  it("resolves comments through docs.comment.resolve with access-scoped input", async () => {
    const store = new FakeDocsStore();
    const registry = createToolRegistry();
    registerDocsTools(registry, { store });
    const commentId = "55555555-5555-4555-8555-555555555555";

    const result = await registry.invoke(
      "docs.comment.resolve",
      { commentId },
      { actor: { id: actorId, orgId, type: "user", scopes: ["docs.comment"] } },
    );

    expect(result.ok).toBe(true);
    expect(store.commentResolutions).toEqual([{ orgId, actorId, commentId }]);
    expect(result.ok ? result.output : undefined).toMatchObject({
      id: commentId,
      status: "resolved",
      resolvedAt: now.toISOString(),
    });
  });

  it("updates, deletes, and reopens comments through docs.comment lifecycle tools", async () => {
    const store = new FakeDocsStore();
    const registry = createToolRegistry();
    registerDocsTools(registry, { store });
    const commentId = "55555555-5555-4555-8555-555555555555";
    const actor = { id: actorId, orgId, type: "user" as const, scopes: ["docs.comment"] };

    const updated = await registry.invoke(
      "docs.comment.update",
      { commentId, body: "Updated note" },
      { actor },
    );
    const deleted = await registry.invoke("docs.comment.delete", { commentId }, { actor });
    const reopened = await registry.invoke("docs.comment.reopen", { commentId }, { actor });

    expect(updated.ok).toBe(true);
    expect(deleted.ok).toBe(true);
    expect(reopened.ok).toBe(true);
    expect(store.commentUpdates).toEqual([{ orgId, actorId, commentId, body: "Updated note" }]);
    expect(store.commentDeletions).toEqual([{ orgId, actorId, commentId }]);
    expect(store.commentReopens).toEqual([{ orgId, actorId, commentId }]);
    expect(updated.ok ? updated.output : undefined).toMatchObject({
      id: commentId,
      body: "Updated note",
    });
    expect(deleted.ok ? deleted.output : undefined).toMatchObject({ id: commentId });
    expect(reopened.ok ? reopened.output : undefined).toMatchObject({
      id: commentId,
      status: "open",
      resolvedAt: null,
    });
  });

  it("registers the Docs comment lifecycle tools", () => {
    const tools = createDocsToolDefinitions({ store: new FakeDocsStore() });
    const ids = tools.map((tool) => tool.id);

    expect(ids).toEqual(
      expect.arrayContaining(["docs.comment.delete", "docs.comment.reopen", "docs.comment.update"]),
    );
    expect(tools.find((tool) => tool.id === "docs.comment.delete")?.confirmationRequired).toBe(
      true,
    );
  });

  it("emits privacy-safe metering after docs.export succeeds", async () => {
    const store = new FakeDocsStore();
    const metering: RecordedMeteringEvent[] = [];
    const registry = createToolRegistry();
    registerDocsTools(registry, {
      store,
      metering: createRecordingMeteringClient(metering),
    });

    const result = await registry.invoke<DocsExportResult>(
      "docs.export",
      {
        docId,
        format: "pdf",
        includeComments: true,
        filename: "Board Packet Export.pdf",
      },
      {
        actor: {
          id: actorId,
          orgId,
          type: "user",
          displayName: "Ada Lovelace",
          email: "ada@example.test",
          scopes: ["docs.read"],
        },
        request: {
          requestId: "request-export",
          traceId: "trace-export",
          spanId: "span-export",
          ip: "203.0.113.10",
          userAgent: "test-agent",
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.output.format).toBe("pdf");
    expect(store.exports).toEqual([
      {
        orgId,
        actorId,
        docId,
      },
    ]);
    expect(metering).toEqual([
      {
        orgId,
        event: {
          type: "export.completed",
          quantity: 1,
          metadata: {
            format: "pdf",
            byte_size: result.output.byteSize,
          },
        },
        trace: {
          traceId: "trace-export",
          spanId: "span-export",
        },
      },
    ]);

    const serializedMetering = JSON.stringify(metering);
    expect(serializedMetering).not.toContain(docId);
    expect(serializedMetering).not.toContain(actorId);
    expect(serializedMetering).not.toContain("Board Packet");
    expect(serializedMetering).not.toContain("Board Packet Export.pdf");
    expect(serializedMetering).not.toContain("Confidential roadmap");
    expect(serializedMetering).not.toContain("Needs owner");
    expect(serializedMetering).not.toContain("ada@example.test");
    expect(serializedMetering).not.toContain("Ada Lovelace");
    expect(serializedMetering).not.toContain("203.0.113.10");
    expect(serializedMetering).not.toContain("test-agent");
  });

  it("renders PDF exports through the configured Chromium renderer", async () => {
    const store = new FakeDocsStore();
    const registry = createToolRegistry();
    const renderedPdf = Buffer.from("%PDF-1.7\n% chromium\n", "utf8");
    const renderInputs: string[] = [];
    registerDocsTools(registry, {
      store,
      pdfRenderer: {
        async render(input) {
          renderInputs.push(input.html);
          return {
            buffer: renderedPdf,
            metadata: { chromiumRevision: "test" },
          };
        },
      },
    });

    const result = await registry.invoke<DocsExportResult>(
      "docs.export",
      { docId, format: "pdf", includeComments: true },
      { actor: { id: actorId, orgId, type: "user", scopes: ["docs.read"] } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(renderInputs).toHaveLength(1);
    expect(renderInputs[0]).toContain("<h1>Board Packet</h1>");
    expect(result.output.contentBase64).toBe(renderedPdf.toString("base64"));
    expect(result.output.metadata).toMatchObject({
      generatedBy: "helix.docs.export.pdf.chromium",
      renderer: "headless-chromium",
      chromiumRevision: "test",
    });
  });

  it("blocks docs.export when the tenant hourly export quota is exhausted", async () => {
    const store = new FakeDocsStore();
    const metering: RecordedMeteringEvent[] = [];
    const events = new RecordingEventBus();
    const registry = createToolRegistry();
    registerDocsTools(registry, {
      store,
      exportJobLimiter: new InMemoryTenantHourlyQuotaLimiter(),
      exportJobLimit: () => 1,
      quotaEvents: events,
      metering: createRecordingMeteringClient(metering),
    });
    const actor = { id: actorId, orgId, type: "user" as const, scopes: ["docs.read"] };

    const allowed = await registry.invoke("docs.export", { docId, format: "markdown" }, { actor });
    const blocked = await registry.invoke("docs.export", { docId, format: "pdf" }, { actor });

    expect(allowed.ok).toBe(true);
    expect(blocked).toMatchObject({
      ok: false,
      statusCode: 429,
      error: "Tenant export job quota exceeded.",
      quotaLimit: {
        quota: "export_jobs_per_hour",
        limit: 1,
        used: 1,
        remaining: 0,
      },
    });
    expect(blocked.ok ? undefined : blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(store.exports).toEqual([
      {
        orgId,
        actorId,
        docId,
      },
    ]);
    expect(metering).toHaveLength(1);
    expect(events.records).toHaveLength(1);
    expect(events.records[0]).toMatchObject({
      subject: "quota.export_jobs.exceeded",
      payload: {
        orgId,
        quota: "export_jobs_per_hour",
        surface: "docs.export",
        limit: 1,
        used: 1,
        remaining: 0,
        metadata: {
          format: "pdf",
        },
      },
    });
    const payload = asRecord(events.records[0]?.payload);
    expect(typeof payload.retryAfterSeconds).toBe("number");
    expect(typeof payload.resetsAt).toBe("string");
  });

  it("treats a null docs.export hourly quota as unlimited", async () => {
    const store = new FakeDocsStore();
    const registry = createToolRegistry();
    registerDocsTools(registry, {
      store,
      exportJobLimiter: new InMemoryTenantHourlyQuotaLimiter(),
      exportJobLimit: () => null,
    });
    const actor = { id: actorId, orgId, type: "user" as const, scopes: ["docs.read"] };

    await expect(
      registry.invoke("docs.export", { docId, format: "markdown" }, { actor }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      registry.invoke("docs.export", { docId, format: "pdf" }, { actor }),
    ).resolves.toMatchObject({ ok: true });

    expect(store.exports).toHaveLength(2);
  });

  it("lists update-backed versions through docs.version.list", async () => {
    const store = new FakeDocsStore();
    const registry = createToolRegistry();
    registerDocsTools(registry, { store });

    const result = await registry.invoke(
      "docs.version.list",
      { docId, limit: 10 },
      { actor: { id: actorId, orgId, type: "user", scopes: ["docs.read"] } },
    );

    expect(result.ok).toBe(true);
    expect(store.versionLists).toEqual([
      {
        orgId,
        actorId,
        documentId: docId,
        limit: 10,
      },
    ]);
    expect(result.ok ? result.output : undefined).toMatchObject({
      versions: [
        {
          id: "66666666-6666-4666-8666-666666666666",
          documentId: docId,
          actorId,
          seq: 3,
          byteSize: 12,
          metadata: { source: "test" },
          createdAt: now.toISOString(),
        },
      ],
    });
  });

  it("names update-backed versions through docs.version.rename", async () => {
    const store = new FakeDocsStore();
    const registry = createToolRegistry();
    registerDocsTools(registry, { store });
    const versionId = "66666666-6666-4666-8666-666666666666";

    const result = await registry.invoke(
      "docs.version.rename",
      { versionId, name: "Board-approved draft" },
      { actor: { id: actorId, orgId, type: "user", scopes: ["docs.write"] } },
    );

    expect(result.ok).toBe(true);
    expect(store.versionNames).toEqual([
      {
        orgId,
        actorId,
        versionId,
        name: "Board-approved draft",
      },
    ]);
    expect(result.ok ? result.output : undefined).toMatchObject({
      id: versionId,
      metadata: { source: "test", name: "Board-approved draft" },
    });
  });

  it("previews update-backed versions through docs.version.preview", async () => {
    const store = new FakeDocsStore();
    const registry = createToolRegistry();
    registerDocsTools(registry, { store });
    const versionId = "66666666-6666-4666-8666-666666666666";

    const result = await registry.invoke(
      "docs.version.preview",
      { versionId },
      { actor: { id: actorId, orgId, type: "user", scopes: ["docs.read"] } },
    );

    expect(result.ok).toBe(true);
    expect(store.versionPreviews).toEqual([
      {
        orgId,
        actorId,
        versionId,
      },
    ]);
    expect(result.ok ? result.output : undefined).toMatchObject({
      version: { id: versionId, metadata: { source: "test" } },
      currentUpdateSeq: 7,
      currentText: "Current text",
      versionText: "Preview text",
      complete: true,
      appliedCount: 2,
      skippedCount: 0,
      diff: [
        { kind: "removed", text: "Preview text" },
        { kind: "added", text: "Current text" },
      ],
    });
  });

  it("restores complete update-backed versions through docs.version.restore", async () => {
    const store = new FakeDocsStore();
    const registry = createToolRegistry();
    registerDocsTools(registry, { store });
    const versionId = "66666666-6666-4666-8666-666666666666";

    const result = await registry.invoke(
      "docs.version.restore",
      { versionId, expectedCurrentUpdateSeq: 7 },
      { actor: { id: actorId, orgId, type: "user", scopes: ["docs.write"] } },
    );

    expect(result.ok).toBe(true);
    expect(store.versionRestores).toEqual([
      {
        orgId,
        actorId,
        versionId,
        expectedCurrentUpdateSeq: 7,
      },
    ]);
    expect(result.ok ? result.output : undefined).toMatchObject({
      document: { id: docId, updateSeq: 4 },
      restoredVersion: { id: versionId },
      restoreVersion: {
        seq: 4,
        metadata: { source: "docs.version.restore", restoredVersionId: versionId },
      },
    });
  });
});

class FakeDocsStore {
  readonly created: CreateDocsDocumentInput[] = [];
  readonly exports: Array<{
    readonly orgId: string;
    readonly actorId: string;
    readonly docId: string;
  }> = [];
  readonly commentLists: Array<{
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly status?: string | undefined;
  }> = [];
  readonly commentCreations: Array<{
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly parentCommentId?: string | undefined;
    readonly body: string;
    readonly anchor?: JsonObject | undefined;
    readonly metadata?: JsonObject | undefined;
  }> = [];
  readonly commentResolutions: Array<{
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }> = [];
  readonly commentReopens: Array<{
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }> = [];
  readonly commentUpdates: Array<{
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
    readonly body: string;
  }> = [];
  readonly commentDeletions: Array<{
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }> = [];
  readonly nativeMigrations: Array<{
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
  }> = [];
  readonly layoutUpdates: Array<{
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly layoutSettings: NativeDocumentLayoutSettings;
  }> = [];
  readonly versionLists: Array<{
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly limit: number;
  }> = [];
  readonly versionNames: Array<{
    readonly orgId: string;
    readonly actorId: string;
    readonly versionId: string;
    readonly name: string;
  }> = [];
  readonly versionPreviews: Array<{
    readonly orgId: string;
    readonly actorId: string;
    readonly versionId: string;
  }> = [];
  readonly versionRestores: Array<{
    readonly orgId: string;
    readonly actorId: string;
    readonly versionId: string;
    readonly expectedCurrentUpdateSeq?: number | undefined;
  }> = [];

  async create(input: CreateDocsDocumentInput): Promise<DocsDocumentRecord> {
    this.created.push(input);
    return {
      id: docId,
      orgId: input.orgId,
      title: input.title,
      threadId: null,
      ownerActorId: input.actorId,
      createdByActorId: input.actorId,
      ydocState: Buffer.from("state", "utf8"),
      ydocStateVector: Buffer.from("vector", "utf8"),
      updateSeq: 0,
      editorEngine: input.editorEngine ?? "legacy-yjs",
      formatVersion: input.formatVersion ?? 1,
      metadata: input.metadata ?? {},
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getDocsExportDocument(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly docId: string;
  }): Promise<DocsExportDocument | null> {
    this.exports.push(input);
    return {
      id: input.docId,
      orgId: input.orgId,
      title: "Board Packet",
      markdown: "# Board Packet\n\nConfidential roadmap",
      comments: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          body: "Needs owner",
          author: {
            id: input.actorId,
            displayName: "Ada Lovelace",
            email: "ada@example.test",
          },
        },
      ],
      updatedAt: now,
      metadata: { classification: "confidential" },
    };
  }

  async migrateToNativeDocument(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
  }): Promise<DocsDocumentRecord | null> {
    this.nativeMigrations.push(input);
    return {
      id: input.documentId,
      orgId: input.orgId,
      title: "Migrated doc",
      threadId: null,
      ownerActorId: input.actorId,
      createdByActorId: input.actorId,
      ydocState: Buffer.from("native-state", "utf8"),
      ydocStateVector: Buffer.from("native-vector", "utf8"),
      updateSeq: 2,
      editorEngine: HELIX_NATIVE_DOCUMENT_ENGINE,
      formatVersion: 1,
      metadata: { migratedFromEditorEngine: "legacy-yjs" },
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async updateLayout(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly layoutSettings: NativeDocumentLayoutSettings;
  }): Promise<DocsDocumentRecord | null> {
    this.layoutUpdates.push(input);
    return {
      id: input.documentId,
      orgId: input.orgId,
      title: "Native doc",
      threadId: null,
      ownerActorId: input.actorId,
      createdByActorId: input.actorId,
      ydocState: Buffer.from("native-state", "utf8"),
      ydocStateVector: Buffer.from("native-vector", "utf8"),
      updateSeq: 2,
      editorEngine: HELIX_NATIVE_DOCUMENT_ENGINE,
      formatVersion: 1,
      metadata: { nativeDocumentLayout: input.layoutSettings as unknown as JsonObject },
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async listComments(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly status?: string | undefined;
  }): Promise<readonly DocsCommentListItem[]> {
    this.commentLists.push(input);
    return [
      {
        id: "55555555-5555-4555-8555-555555555555",
        orgId: input.orgId,
        documentId: input.documentId,
        parentCommentId: null,
        actorId: input.actorId,
        anchor: { kind: "document" },
        body: "Needs owner",
        status: "open",
        metadata: {},
        author: {
          id: input.actorId,
          displayName: "Ada",
          email: "ada@example.test",
        },
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  async createComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly parentCommentId?: string | undefined;
    readonly body: string;
    readonly anchor?: JsonObject | undefined;
    readonly metadata?: JsonObject | undefined;
  }): Promise<DocsCommentRecord> {
    this.commentCreations.push(input);
    return {
      id: "88888888-8888-4888-8888-888888888888",
      orgId: input.orgId,
      documentId: input.documentId,
      parentCommentId: input.parentCommentId ?? null,
      actorId: input.actorId,
      anchor: input.anchor ?? {},
      body: input.body,
      status: "open",
      metadata: input.metadata ?? {},
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async resolveComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DocsCommentRecord | null> {
    this.commentResolutions.push(input);
    return {
      id: input.commentId,
      orgId: input.orgId,
      documentId: docId,
      parentCommentId: null,
      actorId: input.actorId,
      anchor: { kind: "document" },
      body: "Needs owner",
      status: "resolved",
      metadata: {},
      resolvedAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  async reopenComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DocsCommentRecord | null> {
    this.commentReopens.push(input);
    return {
      id: input.commentId,
      orgId: input.orgId,
      documentId: docId,
      parentCommentId: null,
      actorId: input.actorId,
      anchor: { kind: "document" },
      body: "Needs owner",
      status: "open",
      metadata: {},
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async updateComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
    readonly body: string;
  }): Promise<DocsCommentRecord | null> {
    this.commentUpdates.push(input);
    return {
      id: input.commentId,
      orgId: input.orgId,
      documentId: docId,
      parentCommentId: null,
      actorId: input.actorId,
      anchor: { kind: "document" },
      body: input.body,
      status: "open",
      metadata: {},
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async deleteComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DocsCommentRecord | null> {
    this.commentDeletions.push(input);
    return {
      id: input.commentId,
      orgId: input.orgId,
      documentId: docId,
      parentCommentId: null,
      actorId: input.actorId,
      anchor: { kind: "document" },
      body: "Needs owner",
      status: "open",
      metadata: {},
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async listVersions(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly limit: number;
  }): Promise<readonly DocsUpdateRecord[]> {
    this.versionLists.push(input);
    return [
      {
        id: "66666666-6666-4666-8666-666666666666",
        orgId: input.orgId,
        documentId: input.documentId,
        actorId: input.actorId,
        seq: 3,
        update: Buffer.from("hello world!", "utf8"),
        metadata: { source: "test" },
        createdAt: now,
      },
    ];
  }

  async nameVersion(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly versionId: string;
    readonly name: string;
  }): Promise<DocsUpdateRecord | null> {
    this.versionNames.push(input);
    return {
      id: input.versionId,
      orgId: input.orgId,
      documentId: docId,
      actorId: input.actorId,
      seq: 3,
      update: Buffer.from("hello world!", "utf8"),
      metadata: { source: "test", name: input.name },
      createdAt: now,
    };
  }

  async previewVersion(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly versionId: string;
  }): Promise<DocsVersionPreviewRecord | null> {
    this.versionPreviews.push(input);
    return {
      version: {
        id: input.versionId,
        orgId: input.orgId,
        documentId: docId,
        actorId: input.actorId,
        seq: 3,
        update: Buffer.from("hello world!", "utf8"),
        metadata: { source: "test" },
        createdAt: now,
      },
      documentId: docId,
      currentUpdateSeq: 7,
      currentText: "Current text",
      versionText: "Preview text",
      completeness: "reconstructed",
      complete: true,
      appliedCount: 2,
      skippedCount: 0,
      diff: [
        { kind: "removed", text: "Preview text" },
        { kind: "added", text: "Current text" },
      ],
      warnings: [],
    };
  }

  async restoreVersion(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly versionId: string;
    readonly expectedCurrentUpdateSeq?: number | undefined;
  }): Promise<DocsVersionRestoreRecord | null> {
    this.versionRestores.push(input);
    return {
      document: {
        id: docId,
        orgId: input.orgId,
        title: "Restored doc",
        threadId: null,
        ownerActorId: input.actorId,
        createdByActorId: input.actorId,
        ydocState: Buffer.from("state", "utf8"),
        ydocStateVector: Buffer.from("vector", "utf8"),
        updateSeq: 4,
        editorEngine: "helix-native-document",
        formatVersion: 1,
        metadata: {},
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      restoredVersion: {
        id: input.versionId,
        orgId: input.orgId,
        documentId: docId,
        actorId: input.actorId,
        seq: 3,
        update: Buffer.from("hello world!", "utf8"),
        metadata: { source: "test" },
        createdAt: now,
      },
      restoreVersion: {
        id: "77777777-7777-4777-8777-777777777777",
        orgId: input.orgId,
        documentId: docId,
        actorId: input.actorId,
        seq: 4,
        update: Buffer.from("restored state", "utf8"),
        metadata: { source: "docs.version.restore", restoredVersionId: input.versionId },
        createdAt: now,
      },
    };
  }
}

interface RecordedMeteringEvent {
  readonly orgId: string;
  readonly event: MeteringEvent;
  readonly trace?: TraceContext | undefined;
}

function createRecordingMeteringClient(events: RecordedMeteringEvent[]): MeteringClient {
  return {
    async emit(orgId: string, event: MeteringEvent, trace?: TraceContext): Promise<void> {
      events.push({ orgId, event, ...(trace === undefined ? {} : { trace }) });
    },
    async emitBatch(inputs: readonly MeteringEmitInput[]): Promise<void> {
      for (const input of inputs) {
        events.push({
          orgId: input.orgId,
          event: input.event,
          ...(input.trace === undefined ? {} : { trace: input.trace }),
        });
      }
    },
  };
}

class RecordingEventBus {
  readonly records: { readonly subject: string; readonly payload: unknown }[] = [];

  async publish(subject: string, payload: unknown): Promise<void> {
    this.records.push({ subject, payload });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected quota event payload to be an object.");
  }
  return value as Record<string, unknown>;
}
