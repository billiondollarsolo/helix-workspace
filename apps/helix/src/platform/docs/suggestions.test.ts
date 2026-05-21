import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import { createDocsToolDefinitions, registerDocsTools } from "./tools.js";
import type {
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
    if (input.status === "accepted") {
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
        "docs.suggestion.create",
        "docs.suggestion.list",
        "docs.suggestion.resolve",
      ]),
    );
    const resolveTool = tools.find((tool) => tool.id === "docs.suggestion.resolve");
    const createTool = tools.find((tool) => tool.id === "docs.suggestion.create");
    expect(resolveTool?.permission).toBe("docs.write");
    expect(createTool?.permission).toBe("docs.comment");
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
