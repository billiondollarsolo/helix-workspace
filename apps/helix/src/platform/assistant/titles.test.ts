import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { InMemoryAssistantStore } from "./store.js";
import { applyGeneratedTitle, parseGeneratedTitle, titleAfterFirstTurn } from "./titles.js";

const actor: Actor = {
  id: "10000000-0000-4000-8000-000000000001",
  orgId: "20000000-0000-4000-8000-000000000001",
  type: "user",
};

describe("assistant title generation", () => {
  it("parses plain, quoted, and JSON titles and ignores think blocks", () => {
    expect(parseGeneratedTitle('  "Atlas ZIP lookup"  ')).toBe("Atlas ZIP lookup");
    expect(parseGeneratedTitle('{"title":"Weekend forecast"}')).toBe("Weekend forecast");
    expect(parseGeneratedTitle("<think>plan</think>\nMail summary")).toBe("Mail summary");
    expect(parseGeneratedTitle("x")).toBeUndefined();
  });

  it("renames a first-turn conversation and ignores echo replies", async () => {
    const store = new InMemoryAssistantStore();
    const conversation = await store.createConversation({ actor, title: "What is the Atlas ZIP?" });
    const response = {
      id: "m1",
      conversationId: conversation.id,
      orgId: actor.orgId,
      actorId: actor.id,
      role: "assistant" as const,
      content: "20882",
      toolCallId: null,
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    const turn = {
      conversation,
      messages: [response],
      response,
      ai: { message: "20882", model: "test", providerId: "test" },
      toolCalls: [],
      sources: [],
      memory: [],
      pendingConfirmations: [],
      effectiveClassification: "standard" as const,
    };
    const titled = await applyGeneratedTitle({
      store,
      ai: {
        chat: async () => ({
          message: '{"title":"Atlas ZIP lookup"}',
          model: "test",
          providerId: "test",
        }),
      },
      actor,
      user: "What is the Atlas ZIP?",
      enabled: true,
      turn,
    });
    expect(titled.conversation.title).toBe("Atlas ZIP lookup");
    const echoed = await applyGeneratedTitle({
      store,
      ai: {
        chat: async () => ({ message: "20882", model: "test", providerId: "test" }),
      },
      actor,
      user: "What is the Atlas ZIP?",
      enabled: true,
      turn,
    });
    expect(echoed.conversation.title).toBe("What is the Atlas ZIP?");
    const failed = await titleAfterFirstTurn(
      {
        store,
        ai: {
          chat: async () => {
            throw new Error("provider 400");
          },
        },
        generateTitles: true,
      },
      { actor, content: "What is the Atlas ZIP?" },
      turn,
    );
    expect(failed.conversation.id).toBe(conversation.id);
  });
});
