import { describe, expect, it } from "vitest";
import type {
  AICallContext,
  AICapability,
  Actor,
  ChatRequest,
  ChatResponse,
  EventBus,
  EventEnvelope,
  JsonObject,
  JsonValue,
  SuggestionSlotProviderCapability,
  TraceContext,
  Unsubscribe,
} from "@helix/sdk-types";
import { createToolRegistry } from "../tool-registry.js";
import { SearchEventIndexer } from "../search/event-indexer.js";
import type {
  IndexDocument,
  SearchEngine,
  SearchRequest,
  SearchResponse,
} from "../search/types.js";
import {
  createDocsOutlineEnrichmentHandler,
  createDocsSuggestionSlotProviders,
  registerDocsIndexer,
} from "./index.js";
import { exportDocsDocument } from "./export/index.js";
import { registerDocsTools } from "./tools.js";
import type {
  DocsActor,
  DocsCommentProjection,
  DocsCommentRecord,
  DocsDocumentRecord,
  DocsExportDocument,
  DocsExportFormat,
  DocsExportResult,
  DocsOutlineEnrichmentRecord,
  DocsOutlineEnrichmentStore,
  DocsOutlineItem,
  DocsSearchProjectionStore,
  DocsSearchRecord,
} from "./types.js";
import { enrichDocsOutlineFromText } from "./ai/index.js";

const docId = "11111111-1111-4111-8111-111111111111";
const commentId = "22222222-2222-4222-8222-222222222222";

describe("docs export AI search E2E", () => {
  it("covers create update-title comment export search outline enrichment and AI slots with fakes", async () => {
    const ada: Actor = {
      id: "actor-ada",
      orgId: "org-1",
      type: "user",
      displayName: "Ada",
      email: "ada@example.com",
      scopes: ["docs.read", "docs.write", "docs.comment"],
    };
    const events = new FakeEventBus();
    const engine = new FakeSearchEngine();
    const docs = new FakeDocsService(events);
    const ai = new FakeAI();

    const indexer = new SearchEventIndexer({ events, engine });
    registerDocsIndexer(indexer, docs);
    await indexer.start();

    const document = await docs.create({
      actor: ada,
      title: "Launch Plan",
      markdown: [
        "## Goals",
        "Ship the docs editor export scaffolds.",
        "## Risks",
        "Search parity and export validation remain open.",
      ].join("\n"),
      tags: ["launch", "docs"],
    });
    const renamed = await docs.updateTitle({
      actor: ada,
      docId: document.id,
      title: "Launch Readiness Plan",
    });
    const comment = await docs.comment({
      actor: ada,
      docId: document.id,
      body: "Please verify the PDF export before release.",
      anchor: "risks",
    });

    const outlineHandler = createDocsOutlineEnrichmentHandler({ store: docs, ai });
    const outlineResult = await outlineHandler.enrich({
      subject: "activity.docs.document.updated",
      payload: { docId: document.id },
      occurredAt: now(),
    });

    const registry = createToolRegistry();
    registerDocsTools(registry, { store: docs });
    const toolDocument = await registry.invoke(
      "docs.get",
      {
        docId: document.id,
      },
      { actor: ada },
    );
    const toolDocumentList = await registry.invoke(
      "docs.list",
      {
        query: "Launch",
      },
      { actor: ada },
    );
    const markdownExport = await registry.invoke(
      "docs.export",
      {
        docId: document.id,
        format: "markdown",
      },
      { actor: ada },
    );
    const pdfExport = await registry.invoke(
      "docs.export",
      { docId: document.id, format: "pdf", includeComments: true },
      { actor: ada },
    );
    const docxExport = await registry.invoke(
      "docs.export",
      { docId: document.id, format: "docx" },
      { actor: ada },
    );

    const search = await engine.search({
      query: "launch readiness pdf export risks",
      types: ["docs"],
    });
    const providers = createDocsSuggestionSlotProviders({ ai });
    const smartWrite = await collectSuggestion(
      requiredProvider(providers, "docs.smart-write").generate({
        actor: ada,
        feature: "docs.smart-write",
        resource: { type: "docs.document", id: document.id, orgId: ada.orgId },
        input: {
          title: renamed.title,
          selection: "Search parity and export validation remain open.",
          prompt: "Make this sound clearer.",
        },
      }),
    );
    const summary = await collectSuggestion(
      requiredProvider(providers, "docs.summarize").generate({
        actor: ada,
        feature: "docs.summarize",
        resource: { type: "docs.document", id: document.id, orgId: ada.orgId },
        input: {
          title: renamed.title,
          markdown: renamed.markdown ?? "",
          outline: renamed.outline ?? [],
        },
      }),
    );
    const translation = await collectSuggestion(
      requiredProvider(providers, "docs.translate").generate({
        actor: ada,
        feature: "docs.translate",
        resource: { type: "docs.document", id: document.id, orgId: ada.orgId },
        input: {
          selection: "Ship the docs editor export scaffolds.",
          targetLanguage: "Spanish",
        },
      }),
    );

    await indexer.stop();

    if (!markdownExport.ok) {
      throw new Error(markdownExport.error);
    }
    if (!toolDocument.ok) {
      throw new Error(toolDocument.error);
    }
    if (!toolDocumentList.ok) {
      throw new Error(toolDocumentList.error);
    }
    if (!pdfExport.ok) {
      throw new Error(pdfExport.error);
    }
    if (!docxExport.ok) {
      throw new Error(docxExport.error);
    }
    const markdownOutput = markdownExport.output as DocsExportResult;
    const pdfOutput = pdfExport.output as DocsExportResult;
    const docxOutput = docxExport.output as DocsExportResult;
    expect(toolDocument.output).toMatchObject({
      id: document.id,
      title: "Launch Readiness Plan",
      ydocState: Buffer.from(renamed.markdown ?? "", "utf8").toString("base64"),
    });
    expect(toolDocumentList.output).toMatchObject({
      documents: [{ id: document.id, title: "Launch Readiness Plan" }],
    });
    expect(renamed.title).toBe("Launch Readiness Plan");
    expect(comment.body).toContain("PDF export");
    expect(docs.outlineWrites).toHaveLength(1);
    expect(outlineResult).toMatchObject({ status: "applied", resourceId: document.id });
    expect(markdownOutput.contentBase64).toBeTruthy();
    expect(Buffer.from(pdfOutput.contentBase64, "base64").toString("utf8")).toContain("%PDF-1.4");
    expect(Buffer.from(docxOutput.contentBase64, "base64").subarray(0, 4).toString("binary")).toBe(
      "PK\u0003\u0004",
    );
    expect(search.hits.map((hit) => hit.id)).toContain(`docs:${document.id}`);
    expect(search.hits[0]?.attributes?.outline).toEqual([
      { id: "h1", level: 2, title: "Goals", anchor: "goals" },
      { id: "h2", level: 2, title: "Risks", anchor: "risks" },
    ]);
    expect(smartWrite).toContain("Smart write:");
    expect(summary).toContain("Summary:");
    expect(translation).toContain("Traduccion:");
    expect(ai.calls.map((call) => call.feature)).toEqual(
      expect.arrayContaining([
        "docs.outline",
        "docs.smart-write",
        "docs.summarize",
        "docs.translate",
      ]),
    );
  });

  it("allows comment-scoped actors to invoke docs.comment.create", async () => {
    const owner: Actor = {
      id: "actor-owner",
      orgId: "org-1",
      type: "user",
      displayName: "Owner",
      scopes: ["docs.write"],
    };
    const commenter: Actor = {
      id: "actor-commenter",
      orgId: "org-1",
      type: "user",
      displayName: "Commenter",
      scopes: ["docs.comment"],
    };
    const docs = new FakeDocsService(new FakeEventBus());
    await docs.create({
      actor: owner,
      title: "Review Plan",
      markdown: "## Scope\nCheck comment permissions.",
    });

    const registry = createToolRegistry();
    registerDocsTools(registry, { store: docs });

    const result = await registry.invoke(
      "docs.comment.create",
      {
        docId,
        body: "Comment-only scope should be enough.",
        anchor: { label: "Scope" },
      },
      { actor: commenter },
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        documentId: docId,
        actorId: commenter.id,
        body: "Comment-only scope should be enough.",
      },
    });
  });
});

interface CreateInput {
  readonly actor: Actor;
  readonly title: string;
  readonly markdown: string;
  readonly tags?: readonly string[] | undefined;
}

interface UpdateTitleInput {
  readonly actor: Actor;
  readonly docId: string;
  readonly title: string;
}

interface CommentInput {
  readonly actor: Actor;
  readonly docId: string;
  readonly body: string;
  readonly anchor?: string | undefined;
}

interface ExportInput {
  readonly docId?: string | undefined;
  readonly documentId?: string | undefined;
  readonly format: DocsExportFormat;
  readonly includeComments?: boolean | undefined;
}

interface OutlineWrite {
  readonly docId: string;
  readonly outline: readonly DocsOutlineItem[];
  readonly summary?: string | undefined;
}

class FakeDocsService implements DocsSearchProjectionStore, DocsOutlineEnrichmentStore {
  readonly #records = new Map<string, DocsSearchRecord>();
  readonly outlineWrites: OutlineWrite[] = [];

  constructor(private readonly events: EventBus) {}

  async create(input: CreateInput): Promise<DocsSearchRecord> {
    const record: DocsSearchRecord = {
      id: docId,
      orgId: input.actor.orgId,
      title: input.title,
      markdown: input.markdown,
      plainText: input.markdown,
      outline: enrichDocsOutlineFromText(input.markdown),
      owner: actorToDocsActor(input.actor),
      collaborators: [actorToDocsActor(input.actor)],
      tags: input.tags ?? [],
      classification: "standard",
      createdAt: now(),
      updatedAt: now(),
      metadata: {},
    };
    this.#records.set(record.id, record);
    await this.events.publish("activity.docs.document.created", {
      docId: record.id,
      actorId: input.actor.id,
    });
    return record;
  }

  async updateTitle(input: UpdateTitleInput): Promise<DocsSearchRecord> {
    const existing = this.requireRecord(input.docId);
    const updated = { ...existing, title: input.title, updatedAt: now() };
    this.#records.set(input.docId, updated);
    await this.events.publish("activity.docs.document.updated", {
      docId: input.docId,
      actorId: input.actor.id,
    });
    return updated;
  }

  async comment(input: CommentInput): Promise<DocsCommentProjection> {
    const existing = this.requireRecord(input.docId);
    const comment: DocsCommentProjection = {
      id: commentId,
      author: actorToDocsActor(input.actor),
      body: input.body,
      ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
      createdAt: now(),
    };
    const updated = {
      ...existing,
      comments: [...(existing.comments ?? []), comment],
      updatedAt: now(),
    };
    this.#records.set(input.docId, updated);
    await this.events.publish("activity.docs.comment.created", {
      docId: input.docId,
      commentId,
      actorId: input.actor.id,
    });
    return comment;
  }

  export(input: ExportInput): DocsExportResult {
    const exportDocId = input.docId ?? input.documentId;
    if (exportDocId === undefined) {
      throw new Error("document id required");
    }
    return exportDocsDocument({
      document: this.requireRecord(exportDocId),
      format: input.format,
      includeComments: input.includeComments,
    });
  }

  async createComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly body: string;
    readonly anchor?: Record<string, unknown> | undefined;
  }): Promise<DocsCommentRecord> {
    const existing = this.requireRecord(input.documentId);
    if (existing.orgId !== input.orgId) {
      throw new Error(`unknown docs document ${input.documentId}`);
    }
    const comment: DocsCommentRecord = {
      id: commentId,
      orgId: input.orgId,
      documentId: input.documentId,
      actorId: input.actorId,
      anchor: toJsonObject(input.anchor ?? {}),
      body: input.body,
      status: "open",
      metadata: {},
      resolvedAt: null,
      createdAt: new Date(now()),
      updatedAt: new Date(now()),
    };
    const projection: DocsCommentProjection = {
      id: comment.id,
      author: { id: input.actorId },
      body: comment.body,
      anchor: comment.anchor,
      createdAt: now(),
    };
    this.#records.set(input.documentId, {
      ...existing,
      comments: [...(existing.comments ?? []), projection],
      updatedAt: now(),
    });
    await this.events.publish("activity.docs.comment.created", {
      docId: input.documentId,
      commentId,
      actorId: input.actorId,
    });
    return comment;
  }

  async getDocumentForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
  }): Promise<DocsDocumentRecord | null> {
    void input.actorId;
    const record = this.#records.get(input.documentId);
    if (record === undefined || record.orgId !== input.orgId) {
      return null;
    }
    return {
      id: record.id,
      orgId: record.orgId,
      title: record.title,
      threadId: null,
      ownerActorId: record.owner?.id ?? null,
      createdByActorId: record.owner?.id ?? null,
      ydocState: Buffer.from(record.markdown ?? "", "utf8"),
      ydocStateVector: null,
      updateSeq: 0,
      metadata: record.metadata ?? {},
      deletedAt: null,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt ?? record.createdAt),
    };
  }

  async listDocumentsForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly query?: string | undefined;
    readonly limit: number;
  }): Promise<readonly DocsDocumentRecord[]> {
    void input.actorId;
    const query = input.query?.trim().toLowerCase();
    return Array.from(this.#records.values())
      .filter((record) => record.orgId === input.orgId)
      .filter((record) => query === undefined || record.title.toLowerCase().includes(query))
      .slice(0, input.limit)
      .map((record) => ({
        id: record.id,
        orgId: record.orgId,
        title: record.title,
        threadId: null,
        ownerActorId: record.owner?.id ?? null,
        createdByActorId: record.owner?.id ?? null,
        ydocState: Buffer.from(record.markdown ?? "", "utf8"),
        ydocStateVector: null,
        updateSeq: 0,
        metadata: record.metadata ?? {},
        deletedAt: null,
        createdAt: new Date(record.createdAt),
        updatedAt: new Date(record.updatedAt ?? record.createdAt),
      }));
  }

  async appendUpdate(): Promise<never> {
    throw new Error("appendUpdate is not used by this export-focused fake.");
  }

  async compactDocument(): Promise<never> {
    throw new Error("compactDocument is not used by this export-focused fake.");
  }

  async getDocsSearchRecord(id: string): Promise<DocsSearchRecord | null> {
    return this.#records.get(id) ?? null;
  }

  async getDocsExportDocument(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly docId: string;
  }): Promise<DocsExportDocument | null> {
    void input.actorId;
    const record = this.#records.get(input.docId);
    return record === undefined || record.orgId !== input.orgId ? null : record;
  }

  async getDocsOutlineEnrichmentRecord(id: string): Promise<DocsOutlineEnrichmentRecord | null> {
    return this.#records.get(id) ?? null;
  }

  async recordDocsOutlineEnrichment(input: OutlineWrite): Promise<void> {
    this.outlineWrites.push(input);
    const existing = this.requireRecord(input.docId);
    this.#records.set(input.docId, {
      ...existing,
      outline: input.outline,
      metadata: {
        ...(existing.metadata ?? {}),
        ...(input.summary === undefined ? {} : { outlineSummary: input.summary }),
      },
    });
  }

  private requireRecord(id: string): DocsSearchRecord {
    const record = this.#records.get(id);
    if (record === undefined) {
      throw new Error(`unknown docs document ${id}`);
    }
    return record;
  }
}

function actorToDocsActor(actor: Actor): DocsActor {
  return {
    id: actor.id,
    ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
    ...(actor.email === undefined ? {} : { email: actor.email }),
  };
}

async function collectSuggestion(
  chunks: AsyncIterable<{ readonly text: string }>,
): Promise<string> {
  const text: string[] = [];
  for await (const chunk of chunks) {
    text.push(chunk.text);
  }
  return text.join("");
}

function requiredProvider(
  providers: readonly SuggestionSlotProviderCapability[],
  slotId: string,
): SuggestionSlotProviderCapability {
  const provider = providers.find((candidate) => candidate.slotId === slotId);
  if (provider === undefined) {
    throw new Error(`${slotId} provider missing`);
  }
  return provider;
}

class FakeSearchEngine implements SearchEngine {
  readonly id = "fake-search";
  readonly docs = new Map<string, IndexDocument>();

  async index(document: IndexDocument): Promise<void> {
    this.docs.set(document.id, document);
  }

  async upsert(documents: readonly IndexDocument[]): Promise<void> {
    for (const document of documents) {
      this.docs.set(document.id, document);
    }
  }

  async delete(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      this.docs.delete(id);
    }
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const terms = request.query.toLowerCase().split(/\s+/u).filter(Boolean);
    const hits = [...this.docs.values()].filter((document) => {
      const haystack = `${document.title ?? ""}\n${document.body ?? ""}`.toLowerCase();
      return (
        terms.every((term) => haystack.includes(term)) &&
        (request.types === undefined || request.types.includes(document.type))
      );
    });
    return { hits, query: request.query, estimatedTotalHits: hits.length };
  }
}

class FakeAI implements AICapability {
  readonly calls: ChatRequest[] = [];

  async chat(request: ChatRequest, _ctx?: Partial<AICallContext>): Promise<ChatResponse> {
    void _ctx;
    this.calls.push(request);
    if (request.feature === "docs.smart-write") {
      return {
        message:
          "Smart write: Export validation and search parity are the remaining launch checks.",
        model: "fake-model",
        providerId: "fake-ai",
      };
    }
    if (request.feature === "docs.translate") {
      return {
        message: "Traduccion: Enviar los andamios de exportacion del editor de documentos.",
        model: "fake-model",
        providerId: "fake-ai",
      };
    }
    if (request.feature === "docs.outline") {
      return {
        message: "The document tracks goals and risks for the docs export launch.",
        model: "fake-model",
        providerId: "fake-ai",
      };
    }
    return {
      message:
        "Summary: The plan covers export scaffolds, search parity, risks, and release validation.",
      model: "fake-model",
      providerId: "fake-ai",
    };
  }
}

class FakeEventBus implements EventBus {
  readonly subscriptions: string[] = [];
  readonly #subscribers: {
    readonly subject: string;
    readonly handler: (event: EventEnvelope) => Promise<void>;
  }[] = [];

  async publish(subject: string, payload: JsonValue, trace?: TraceContext): Promise<void> {
    const event: EventEnvelope = {
      subject,
      payload,
      occurredAt: now(),
      ...(trace === undefined ? {} : { trace }),
    };
    for (const subscriber of this.#subscribers) {
      if (subjectMatches(subscriber.subject, subject)) {
        await subscriber.handler(event);
      }
    }
  }

  async subscribe<Payload extends JsonValue>(
    subject: string,
    handler: (event: EventEnvelope<Payload>) => Promise<void>,
  ): Promise<Unsubscribe> {
    this.subscriptions.push(subject);
    const subscriber = {
      subject,
      handler: handler as (event: EventEnvelope) => Promise<void>,
    };
    this.#subscribers.push(subscriber);
    return () => {
      const index = this.#subscribers.indexOf(subscriber);
      if (index >= 0) {
        this.#subscribers.splice(index, 1);
      }
    };
  }
}

function subjectMatches(pattern: string, subject: string): boolean {
  const patternParts = pattern.split(".");
  const subjectParts = subject.split(".");

  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    if (patternPart === ">") {
      return index === patternParts.length - 1;
    }
    if (subjectParts[index] === undefined) {
      return false;
    }
    if (patternPart !== "*" && patternPart !== subjectParts[index]) {
      return false;
    }
  }

  return patternParts.length === subjectParts.length;
}

function now(): string {
  return "2026-05-20T00:00:00.000Z";
}

function toJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
