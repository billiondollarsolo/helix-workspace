import type { Actor } from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { AllowAllToolAccessPolicy } from "../permissions/tool-access.js";
import type { SearchHit } from "../search/index.js";
import { createToolRegistry } from "../tool-registry.js";
import {
  assistantSourceMetadata,
  citationForSearchHit,
  withReaderAnnotations,
} from "./message-annotations.js";
import { AssistantOrchestrator } from "./orchestrator.js";
import { InMemoryAssistantStore } from "./store.js";
import { registerAssistantTools } from "./tools.js";
import type { AssistantCitationAccess, AssistantFeedbackStore, AssistantMessage } from "./types.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const FILE = "22222222-2222-4222-8222-222222222222";
const MAIL = "33333333-3333-4333-8333-333333333333";
const THREAD = "44444444-4444-4444-8444-444444444444";
const actor: Actor = {
  id: "55555555-5555-4555-8555-555555555555",
  orgId: ORG,
  type: "user",
  scopes: ["assistant.write", "drive.read", "mail.read"],
};

const hits: readonly SearchHit[] = [
  {
    id: `drive:${FILE}`,
    type: "drive",
    title: "Board deck",
    body: "Quarterly numbers",
    url: `/drive/${FILE}`,
    attributes: { orgId: ORG, fileId: FILE },
  },
  {
    id: `mail:${MAIL}:${actor.id}`,
    type: "mail",
    title: "Offer letter",
    body: "Compensation details",
    url: `/mail/${THREAD}?message=${MAIL}`,
    attributes: { orgId: ORG, messageId: MAIL, ragOwnerActorId: actor.id },
  },
];

function assistantWith(citationAccess: AssistantCitationAccess) {
  const store = new InMemoryAssistantStore();
  const orchestrator = new AssistantOrchestrator({
    store,
    search: {
      id: "fake-search",
      async index() {},
      async upsert() {},
      async delete() {},
      async search(request) {
        return { query: request.query, hits };
      },
    },
    searchTypes: ["drive", "mail"],
    ai: {
      async chat() {
        return { message: "The deck and the letter agree.", model: "test", providerId: "test" };
      },
    },
    tools: createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() }),
    annotations: { citationAccess },
  });
  return { store, orchestrator };
}

describe("Assistant workspace citations", () => {
  it("saves cited workspace records as references and shows them after reload", async () => {
    const access = vi.fn<AssistantCitationAccess>(async (_actor, ref) => ({
      path: ref.kind === "drive" ? `/drive/${ref.id}` : `/mail/${THREAD}?message=${ref.id}`,
    }));
    const { store, orchestrator } = assistantWith(access);
    const turn = await orchestrator.sendMessage({ actor, content: "Compare the deck and letter" });

    const saved = (
      await store.listMessages({ orgId: ORG, conversationId: turn.conversation.id, limit: 10 })
    ).find((message) => message.role === "assistant");
    expect(saved?.metadata.citations).toEqual([
      { kind: "drive", id: FILE, title: "Board deck" },
      { kind: "mail", id: MAIL, title: "Offer letter" },
    ]);
    // Workspace records are kept as references only, never as source bodies.
    expect(JSON.stringify(saved?.metadata.sources ?? [])).not.toContain("Board deck");

    const reloaded = await orchestrator.getConversation(actor, turn.conversation.id);
    const answer = reloaded.messages.find((message) => message.role === "assistant");
    expect(answer?.citations).toEqual([
      { kind: "drive", id: FILE, title: "Board deck", path: `/drive/${FILE}` },
      { kind: "mail", id: MAIL, title: "Offer letter", path: `/mail/${THREAD}?message=${MAIL}` },
    ]);
    expect(answer?.metadata).not.toHaveProperty("citations");
    expect(access).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ kind: "drive", id: FILE }),
    );
  });

  it("re-checks access on every read and hides records the reader lost, title included", async () => {
    let driveShared = true;
    const { orchestrator } = assistantWith(async (_actor, ref) =>
      ref.kind === "drive" && !driveShared ? null : { path: `/${ref.kind}/${ref.id}` },
    );
    const turn = await orchestrator.sendMessage({ actor, content: "Compare the deck and letter" });
    driveShared = false;

    const reloaded = await orchestrator.getConversation(actor, turn.conversation.id);
    const answer = reloaded.messages.find((message) => message.role === "assistant");
    expect(answer?.citations?.map((citation) => citation.kind)).toEqual(["mail"]);
    expect(JSON.stringify(reloaded.messages)).not.toContain("Board deck");

    // Losing the Mail scope hides Mail citations without asking the store.
    const withoutMail = await orchestrator.getConversation(
      { ...actor, scopes: ["assistant.write"] },
      turn.conversation.id,
    );
    expect(
      withoutMail.messages.find((message) => message.role === "assistant")?.citations,
    ).toBeUndefined();
    expect(JSON.stringify(withoutMail.messages)).not.toContain("Offer letter");
  });

  it("drops a citation whose access check fails", async () => {
    const { orchestrator } = assistantWith(async () => {
      throw new Error("store unavailable");
    });
    const turn = await orchestrator.sendMessage({ actor, content: "Compare the deck and letter" });
    const reloaded = await orchestrator.getConversation(actor, turn.conversation.id);
    expect(reloaded.messages.some((message) => message.citations !== undefined)).toBe(false);
  });
});

describe("message annotation helpers", () => {
  it("cites only workspace hits with a record id", () => {
    expect(citationForSearchHit({ type: "drive", attributes: { fileId: FILE } })).toEqual({
      kind: "drive",
      id: FILE,
    });
    expect(citationForSearchHit({ type: "chat", attributes: { messageId: MAIL } })).toEqual({
      kind: "chat",
      id: MAIL,
    });
    expect(citationForSearchHit({ type: "drive", attributes: { fileId: "../etc" } })).toBe(
      undefined,
    );
    expect(citationForSearchHit({ type: "contact", attributes: { contactId: FILE } })).toBe(
      undefined,
    );
  });

  it("keeps web sources and turns workspace sources into deduplicated references", () => {
    const base = {
      trust: "untrusted_retrieved" as const,
      classification: "standard" as const,
      provenance: { sourceId: "s", sourceType: "drive", orgId: ORG },
    };
    const metadata = assistantSourceMetadata([
      {
        ...base,
        id: "d1",
        type: "drive",
        title: "Deck",
        body: "secret",
        citation: { kind: "drive", id: FILE },
      },
      {
        ...base,
        id: "d2",
        type: "drive",
        title: "Deck again",
        citation: { kind: "drive", id: FILE },
      },
      {
        ...base,
        id: "w1",
        type: "web.search",
        title: "News",
        url: "https://example.com/",
        body: "x",
      },
    ]);
    expect(metadata.citations).toEqual([{ kind: "drive", id: FILE, title: "Deck" }]);
    expect(metadata.sources).toEqual([
      { ...base, id: "w1", type: "web.search", title: "News", url: "https://example.com/" },
    ]);
  });

  it("attaches the reader's feedback and ignores malformed references", async () => {
    const message: AssistantMessage = {
      id: "66666666-6666-4666-8666-666666666666",
      orgId: ORG,
      conversationId: "77777777-7777-4777-8777-777777777777",
      actorId: null,
      role: "assistant",
      content: "Answer",
      toolCallId: null,
      metadata: { citations: [{ kind: "drive", id: "not-a-uuid", title: "Hidden" }] },
      createdAt: new Date().toISOString(),
    };
    const feedback: AssistantFeedbackStore = {
      setFeedback: vi.fn(),
      listFeedback: async () =>
        new Map([[message.id, { rating: "up", comment: null, updatedAt: "2026-10-01T00:00:00Z" }]]),
    };
    const access = vi.fn<AssistantCitationAccess>();
    const [annotated] = await withReaderAnnotations(actor, [message], {
      citationAccess: access,
      feedback,
    });
    expect(access).not.toHaveBeenCalled();
    expect(annotated).toMatchObject({ feedback: { rating: "up" }, metadata: {} });
    expect(JSON.stringify(annotated)).not.toContain("Hidden");
  });
});

describe("assistant.message.feedback tool", () => {
  it("validates input, saves through the owner-scoped store, and reports unknown answers", async () => {
    const saved: unknown[] = [];
    const feedback: AssistantFeedbackStore = {
      async setFeedback(input) {
        saved.push(input);
        return input.messageId === MAIL
          ? null
          : {
              feedback: { rating: "down", comment: "Too vague", updatedAt: "2026-10-01T00:00:00Z" },
            };
      },
      listFeedback: async () => new Map(),
    };
    const registry = createToolRegistry();
    registerAssistantTools(registry, {
      store: new InMemoryAssistantStore(),
      orchestrator: {} as AssistantOrchestrator,
      feedback,
    });
    const conversationId = "88888888-8888-4888-8888-888888888888";

    await expect(
      registry.invoke(
        "assistant.message.feedback",
        { conversationId, messageId: FILE, rating: "meh" },
        { actor },
      ),
    ).resolves.toMatchObject({ ok: false });
    expect(saved).toEqual([]);

    await expect(
      registry.invoke(
        "assistant.message.feedback",
        { conversationId, messageId: FILE, rating: "down", comment: "Too vague" },
        { actor },
      ),
    ).resolves.toMatchObject({
      ok: true,
      output: { messageId: FILE, feedback: { rating: "down", comment: "Too vague" } },
    });
    expect(saved).toEqual([
      { actor, conversationId, messageId: FILE, rating: "down", comment: "Too vague" },
    ]);

    await expect(
      registry.invoke(
        "assistant.message.feedback",
        { conversationId, messageId: MAIL, rating: null },
        { actor },
      ),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("isn't in one of your") });
  });
});
