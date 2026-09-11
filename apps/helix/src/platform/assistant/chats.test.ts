import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { searchChats, viewChat } from "./chats.js";
import { InMemoryAssistantStore } from "./store.js";

const actor: Actor = {
  id: "10000000-0000-4000-8000-000000000001",
  orgId: "20000000-0000-4000-8000-000000000001",
  type: "user",
};

describe("assistant chat recall", () => {
  it("searches other actor-owned conversations and views user/assistant text only", async () => {
    const store = new InMemoryAssistantStore();
    const current = await store.createConversation({ actor, title: "Current weather" });
    const other = await store.createConversation({ actor, title: "Atlas renewal" });
    await store.appendMessage({
      orgId: actor.orgId,
      conversationId: other.id,
      actorId: actor.id,
      role: "user",
      content: "What is the Atlas ZIP?",
    });
    await store.appendMessage({
      orgId: actor.orgId,
      conversationId: other.id,
      actorId: actor.id,
      role: "assistant",
      content: "Atlas is in 20882.",
    });
    await store.appendMessage({
      orgId: actor.orgId,
      conversationId: other.id,
      actorId: actor.id,
      role: "tool",
      content: "secret tool payload",
    });
    const found = await searchChats(store, {
      orgId: actor.orgId,
      actorId: actor.id,
      conversationId: current.id,
      query: "Atlas",
    });
    expect(found.conversations.map((item) => item.id)).toEqual([other.id]);
    const viewed = await viewChat(store, {
      orgId: actor.orgId,
      actorId: actor.id,
      conversationId: other.id,
      currentConversationId: current.id,
    });
    expect(viewed.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(viewed.messages[1]?.content).toContain("20882");
  });

  it("refuses the current conversation and other actors", async () => {
    const store = new InMemoryAssistantStore();
    const current = await store.createConversation({ actor, title: "Now" });
    await expect(
      viewChat(store, {
        orgId: actor.orgId,
        actorId: actor.id,
        conversationId: current.id,
        currentConversationId: current.id,
      }),
    ).rejects.toThrow("current conversation");
    await expect(
      viewChat(store, {
        orgId: actor.orgId,
        actorId: actor.id,
        conversationId: "30000000-0000-4000-8000-000000000001",
        currentConversationId: current.id,
      }),
    ).rejects.toThrow("not found");
  });
});
