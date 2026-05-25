import { describe, expect, it } from "vitest";
import type { AICapability, JsonObject } from "@helix/sdk-types";
import { createToolRegistry } from "../tool-registry.js";
import { createDocsToolDefinitions, registerDocsTools } from "./tools.js";
import type {
  DocsAskHistoryRecord,
  DocsCommentRecord,
  DocsExportDocument,
  DocsSuggestionRecord,
  DocsSuggestionStatus,
} from "./types.js";

const now = new Date("2026-05-21T12:00:00.000Z");
const orgId = "22222222-2222-4222-8222-222222222222";
const docId = "11111111-1111-4111-8111-111111111111";
const suggestionId = "66666666-6666-4666-8666-666666666666";
const actorId = "33333333-3333-4333-8333-333333333333";

class FakeDocsSuggestionStore {
  readonly suggestions = new Map<string, DocsSuggestionRecord>();
  readonly askHistory: DocsAskHistoryRecord[] = [];
  appliedEdits = 0;

  async getDocsExportDocument(): Promise<DocsExportDocument | null> {
    return { id: docId, title: "Doc", markdown: "# Doc\n" };
  }

  async createComment(): Promise<DocsCommentRecord> {
    throw new Error("not used");
  }

  async createSuggestion(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly beforeText: string;
    readonly afterText: string;
    readonly reason?: string;
  }): Promise<DocsSuggestionRecord> {
    const record: DocsSuggestionRecord = {
      id: suggestionId,
      orgId: input.orgId,
      documentId: input.documentId,
      actorId: input.actorId,
      anchor: {},
      beforeText: input.beforeText,
      afterText: input.afterText,
      reason: input.reason ?? "",
      status: "pending",
      metadata: {},
      resolvedByActorId: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.suggestions.set(record.id, record);
    return record;
  }

  async listSuggestions(input: {
    readonly documentId: string;
    readonly status?: DocsSuggestionStatus;
  }): Promise<readonly DocsSuggestionRecord[]> {
    return [...this.suggestions.values()].filter(
      (suggestion) =>
        suggestion.documentId === input.documentId &&
        (input.status === undefined || suggestion.status === input.status),
    );
  }

  async resolveSuggestion(input: {
    readonly actorId: string;
    readonly suggestionId: string;
    readonly status: "accepted" | "rejected";
  }): Promise<DocsSuggestionRecord | null> {
    const existing = this.suggestions.get(input.suggestionId);
    if (existing === undefined) {
      return null;
    }
    if (existing.status === "pending" && input.status === "accepted") {
      this.appliedEdits += 1;
    }
    const resolved: DocsSuggestionRecord = {
      ...existing,
      status: input.status,
      resolvedByActorId: input.actorId,
      resolvedAt: now,
      updatedAt: now,
    };
    this.suggestions.set(resolved.id, resolved);
    return resolved;
  }

  async resolveSuggestions(input: {
    readonly actorId: string;
    readonly documentId: string;
    readonly suggestionIds: readonly string[];
    readonly status: "accepted" | "rejected";
  }): Promise<readonly DocsSuggestionRecord[] | null> {
    const resolved: DocsSuggestionRecord[] = [];
    const existing = input.suggestionIds.map((id) => this.suggestions.get(id));
    if (
      existing.some(
        (suggestion) => suggestion === undefined || suggestion.documentId !== input.documentId,
      )
    ) {
      return null;
    }
    for (const suggestion of existing) {
      if (suggestion === undefined) {
        return null;
      }
      if (suggestion.status !== "pending") {
        resolved.push(suggestion);
        continue;
      }
      if (input.status === "accepted") {
        this.appliedEdits += 1;
      }
      const next: DocsSuggestionRecord = {
        ...suggestion,
        status: input.status,
        resolvedByActorId: input.actorId,
        resolvedAt: now,
        updatedAt: now,
      };
      this.suggestions.set(next.id, next);
      resolved.push(next);
    }
    return resolved;
  }

  async createAskHistoryItem(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly question: string;
    readonly answer: string;
    readonly sourceScope: "document" | "selection";
    readonly sourceExcerpt: string;
    readonly metadata?: JsonObject;
  }): Promise<DocsAskHistoryRecord> {
    const record: DocsAskHistoryRecord = {
      id: `99999999-9999-4999-8999-${String(this.askHistory.length + 1).padStart(12, "0")}`,
      orgId: input.orgId,
      documentId: input.documentId,
      actorId: input.actorId,
      question: input.question,
      answer: input.answer,
      sourceScope: input.sourceScope,
      sourceExcerpt: input.sourceExcerpt,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.askHistory.unshift(record);
    return record;
  }

  async listAskHistory(): Promise<readonly DocsAskHistoryRecord[]> {
    return this.askHistory;
  }

  async clearAskHistory(): Promise<number> {
    const count = this.askHistory.length;
    this.askHistory.splice(0);
    return count;
  }
}

const invokeContext = {
  actor: {
    id: actorId,
    orgId,
    type: "user" as const,
    scopes: ["docs.read", "docs.write", "docs.comment"],
  },
};

describe("docs suggestion tools", () => {
  it("registers suggestion-mode tools distinct from comments", () => {
    const tools = createDocsToolDefinitions({ store: new FakeDocsSuggestionStore() });
    const ids = tools.map((tool) => tool.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "docs.comment.create",
        "docs.comment.list",
        "docs.import-docx",
        "docs.ask.history.clear",
        "docs.ask.history.list",
        "docs.suggestion.create",
        "docs.suggestion.list",
        "docs.suggestion.resolve",
        "docs.suggestion.resolve-batch",
        "docs.version.list",
        "docs.version.preview",
        "docs.version.rename",
        "docs.version.restore",
      ]),
    );
    const resolveTool = tools.find((tool) => tool.id === "docs.suggestion.resolve");
    const createTool = tools.find((tool) => tool.id === "docs.suggestion.create");
    const listCommentsTool = tools.find((tool) => tool.id === "docs.comment.list");
    expect(resolveTool?.permission).toBe("docs.write");
    expect(createTool?.permission).toBe("docs.comment");
    expect(listCommentsTool?.permission).toBe("docs.read");
  });

  it("creates, lists, and accepts a suggestion", async () => {
    const store = new FakeDocsSuggestionStore();
    const registry = createToolRegistry();
    registerDocsTools(registry, { store });

    const created = await registry.invoke(
      "docs.suggestion.create",
      { docId, beforeText: "teh quick", afterText: "the quick", reason: "typo" },
      invokeContext,
    );
    expect(created.ok).toBe(true);

    const listed = await registry.invoke(
      "docs.suggestion.list",
      { docId, status: "pending" },
      invokeContext,
    );
    expect(listed.ok ? (listed.output as { suggestions: unknown[] }).suggestions : []).toHaveLength(
      1,
    );

    const resolved = await registry.invoke(
      "docs.suggestion.resolve",
      { suggestionId, status: "accepted" },
      invokeContext,
    );
    expect(resolved.ok && (resolved.output as { status: string }).status).toBe("accepted");
    expect(store.appliedEdits).toBe(1);
  });

  it("accepts multiple suggestions through an atomic batch tool", async () => {
    const store = new FakeDocsSuggestionStore();
    const registry = createToolRegistry();
    registerDocsTools(registry, { store });
    const first: DocsSuggestionRecord = {
      id: "77777777-7777-4777-8777-777777777777",
      orgId,
      documentId: docId,
      actorId,
      anchor: {},
      beforeText: "teh plan",
      afterText: "the plan",
      reason: "typo",
      status: "pending",
      metadata: {},
      resolvedByActorId: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const second: DocsSuggestionRecord = {
      ...first,
      id: "88888888-8888-4888-8888-888888888888",
      beforeText: "recieve update",
      afterText: "receive update",
    };
    store.suggestions.set(first.id, first);
    store.suggestions.set(second.id, second);

    const resolved = await registry.invoke(
      "docs.suggestion.resolve-batch",
      {
        docId,
        suggestionIds: [first.id, second.id],
        status: "accepted",
      },
      invokeContext,
    );

    expect(resolved.ok).toBe(true);
    expect(
      resolved.ok ? (resolved.output as { suggestions: unknown[] }).suggestions : [],
    ).toHaveLength(2);
    expect(resolved.ok ? (resolved.output as { count: number }).count : 0).toBe(2);
    expect(store.appliedEdits).toBe(2);
    expect([...store.suggestions.values()].map((suggestion) => suggestion.status)).toEqual([
      "accepted",
      "accepted",
    ]);
  });

  it("rejects duplicate suggestion ids in batch resolution", async () => {
    const registry = createToolRegistry();
    registerDocsTools(registry, { store: new FakeDocsSuggestionStore() });

    const resolved = await registry.invoke(
      "docs.suggestion.resolve-batch",
      {
        docId,
        suggestionIds: [suggestionId, suggestionId],
        status: "accepted",
      },
      invokeContext,
    );

    expect(resolved.ok).toBe(false);
  });

  it("generates AI-assisted tracked-change draft text through suggestion slots", async () => {
    const store = new FakeDocsSuggestionStore();
    const aiCalls: unknown[] = [];
    const ai = {
      async chat(request, ctx) {
        aiCalls.push({ request, ctx });
        return {
          message: "the quick",
          model: "test-model",
          providerId: "test-ai",
          metadata: { finishReason: "stop" },
        };
      },
    } satisfies AICapability;
    const registry = createToolRegistry();
    registerDocsTools(registry, { store, ai });

    const generated = await registry.invoke(
      "docs.suggestion.generate",
      {
        docId,
        slotId: "docs.smart-write",
        selection: "teh quick",
        prompt: "Fix the typo",
      },
      invokeContext,
    );

    expect(generated.ok).toBe(true);
    expect(generated.ok ? generated.output : null).toMatchObject({
      slotId: "docs.smart-write",
      text: "the quick",
      metadata: { providerId: "test-ai", model: "test-model", finishReason: "stop" },
    });
    expect(JSON.stringify(aiCalls)).toContain("Fix the typo");
    expect(JSON.stringify(aiCalls)).toContain("teh quick");
    expect(JSON.stringify(aiCalls)).toContain("# Doc");
  });

  it("generates ask-this-document answers with document body context", async () => {
    const store = new FakeDocsSuggestionStore();
    const aiCalls: unknown[] = [];
    const ai = {
      async chat(request, ctx) {
        aiCalls.push({ request, ctx });
        return {
          message: "The launch risk is unresolved ownership.",
          model: "test-model",
          providerId: "test-ai",
          metadata: { finishReason: "stop" },
        };
      },
    } satisfies AICapability;
    const registry = createToolRegistry();
    registerDocsTools(registry, { store, ai });

    const generated = await registry.invoke(
      "docs.suggestion.generate",
      {
        docId,
        slotId: "docs.ask-document",
        selection: "Launch risks",
        body: "# Launch Plan\n\nRisks: ownership remains open.",
        prompt: "What is the main launch risk?",
      },
      invokeContext,
    );

    expect(generated.ok).toBe(true);
    expect(generated.ok ? generated.output : null).toMatchObject({
      slotId: "docs.ask-document",
      text: "The launch risk is unresolved ownership.",
    });
    expect(JSON.stringify(aiCalls)).toContain("What is the main launch risk?");
    expect(JSON.stringify(aiCalls)).toContain("# Launch Plan");
    expect(JSON.stringify(aiCalls)).toContain("Launch risks");
  });

  it("answers ask-this-document questions and persists ask history", async () => {
    const store = new FakeDocsSuggestionStore();
    const aiCalls: unknown[] = [];
    const ai = {
      async chat(request, ctx) {
        aiCalls.push({ request, ctx });
        return {
          message: "The launch risk is unresolved ownership.",
          model: "test-model",
          providerId: "test-ai",
          metadata: { finishReason: "stop" },
        };
      },
    } satisfies AICapability;
    const registry = createToolRegistry();
    registerDocsTools(registry, { store, ai });

    const answered = await registry.invoke(
      "docs.ask.answer",
      {
        docId,
        question: "What is the main launch risk?",
        selection: "Risks: ownership remains open.",
        body: "# Launch Plan\n\nRisks: ownership remains open.",
        sourceScope: "selection",
        citations: [
          {
            label: "Selected text",
            excerpt: "Risks: ownership remains open.",
            sourceScope: "selection",
            selection: { from: 3, to: 33, text: "Risks: ownership remains open." },
          },
        ],
      },
      invokeContext,
    );

    expect(answered.ok).toBe(true);
    expect(answered.ok ? answered.output : null).toMatchObject({
      question: "What is the main launch risk?",
      answer: "The launch risk is unresolved ownership.",
      sourceScope: "selection",
      sourceExcerpt: "Risks: ownership remains open.",
      metadata: {
        citations: [
          {
            label: "Selected text",
            excerpt: "Risks: ownership remains open.",
            sourceScope: "selection",
            selection: { from: 3, to: 33, text: "Risks: ownership remains open." },
          },
        ],
        finishReason: "stop",
        model: "test-model",
        providerId: "test-ai",
      },
    });
    expect(store.askHistory).toHaveLength(1);

    const listed = await registry.invoke(
      "docs.ask.history.list",
      { docId, limit: 10 },
      invokeContext,
    );
    expect(listed.ok ? (listed.output as { history: unknown[] }).history : []).toHaveLength(1);

    const cleared = await registry.invoke("docs.ask.history.clear", { docId }, invokeContext);
    expect(cleared.ok ? (cleared.output as { deleted: number }).deleted : 0).toBe(1);
    expect(store.askHistory).toHaveLength(0);
    expect(JSON.stringify(aiCalls)).toContain("What is the main launch risk?");
  });

  it("rejects a suggestion without applying the edit", async () => {
    const store = new FakeDocsSuggestionStore();
    const registry = createToolRegistry();
    registerDocsTools(registry, { store });
    await registry.invoke(
      "docs.suggestion.create",
      { docId, beforeText: "old", afterText: "new" },
      invokeContext,
    );

    const resolved = await registry.invoke(
      "docs.suggestion.resolve",
      { suggestionId, status: "rejected" },
      invokeContext,
    );
    expect(resolved.ok && (resolved.output as { status: string }).status).toBe("rejected");
    expect(store.appliedEdits).toBe(0);
  });

  it("fails when resolving an unknown suggestion", async () => {
    const registry = createToolRegistry();
    registerDocsTools(registry, { store: new FakeDocsSuggestionStore() });

    const result = await registry.invoke(
      "docs.suggestion.resolve",
      { suggestionId, status: "accepted" },
      invokeContext,
    );
    expect(result.ok).toBe(false);
  });
});
