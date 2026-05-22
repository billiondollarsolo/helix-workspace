import { describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { createToolRegistry } from "../tool-registry.js";
import { InMemoryAssistantStore } from "./store.js";
import type {
  AssistantConversation,
  AssistantConversationListPage,
} from "./types.js";
import { createAssistantToolDefinitions, registerAssistantTools } from "./tools.js";
import type { AssistantOrchestrator } from "./orchestrator.js";

const orgId = "00000000-0000-4000-8000-000000000010";
const actorId = "00000000-0000-4000-8000-000000000001";

const actor: Actor = {
  id: actorId,
  orgId,
  type: "user",
  displayName: "Ada Lovelace",
  email: "ada@example.com",
  scopes: ["assistant.read", "assistant.write"],
};

/** The conversation tools never call the orchestrator; a stub satisfies the type. */
const orchestratorStub = {} as AssistantOrchestrator;

describe("assistant conversation store: list, pin, rename, delete", () => {
  it("lists conversations pinned-first then by recency with previews", async () => {
    const store = new InMemoryAssistantStore();
    const first = await store.createConversation({ actor, title: "Summarize inbox" });
    const second = await store.createConversation({ actor, title: "Draft board update" });
    await store.appendMessage({
      conversationId: second.id,
      orgId,
      actorId,
      role: "user",
      content: "  Help me   draft the Q3 board narrative  ",
    });
    await store.setConversationPinned({
      orgId,
      actorId,
      conversationId: first.id,
      pinned: true,
    });

    const page = await store.listConversations({ orgId, actorId, limit: 10 });
    expect(page.items.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(page.items[0]).toMatchObject({ pinned: true, messageCount: 0 });
    expect(page.items[1]).toMatchObject({
      pinned: false,
      messageCount: 1,
      preview: "Help me draft the Q3 board narrative",
    });
    expect(page.nextCursor).toBeNull();
  });

  it("filters conversations by case-insensitive search over title and last message", async () => {
    const store = new InMemoryAssistantStore();
    const atlas = await store.createConversation({ actor, title: "Atlas renewal" });
    await store.createConversation({ actor, title: "Onboarding hooks" });
    await store.appendMessage({
      conversationId: atlas.id,
      orgId,
      actorId,
      role: "assistant",
      content: "Atlas is a $420K ARR account.",
    });

    const byTitle = await store.listConversations({ orgId, actorId, query: "atlas", limit: 10 });
    expect(byTitle.items.map((item) => item.id)).toEqual([atlas.id]);

    const byMessage = await store.listConversations({ orgId, actorId, query: "420K", limit: 10 });
    expect(byMessage.items.map((item) => item.id)).toEqual([atlas.id]);

    const pinnedOnly = await store.listConversations({
      orgId,
      actorId,
      pinnedOnly: true,
      limit: 10,
    });
    expect(pinnedOnly.items).toEqual([]);
  });

  it("scopes conversations to the owning actor", async () => {
    const store = new InMemoryAssistantStore();
    await store.createConversation({ actor, title: "Mine" });
    const otherActor: Actor = { ...actor, id: "00000000-0000-4000-8000-000000000002" };
    await store.createConversation({ actor: otherActor, title: "Theirs" });

    const page = await store.listConversations({ orgId, actorId, limit: 10 });
    expect(page.items.map((item) => item.title)).toEqual(["Mine"]);
  });

  it("renames and soft-deletes conversations and excludes deleted ones from the list", async () => {
    const store = new InMemoryAssistantStore();
    const conversation = await store.createConversation({ actor, title: "Original" });

    const renamed = await store.renameConversation({
      orgId,
      actorId,
      conversationId: conversation.id,
      title: "Renamed",
    });
    expect(renamed?.title).toBe("Renamed");

    await expect(
      store.deleteConversation({ orgId, actorId, conversationId: conversation.id }),
    ).resolves.toBe(true);
    const page = await store.listConversations({ orgId, actorId, limit: 10 });
    expect(page.items).toEqual([]);
    await expect(
      store.getConversation({ orgId, actorId, conversationId: conversation.id }),
    ).resolves.toBeNull();
  });

  it("returns null/false for unknown conversations on pin/rename/delete", async () => {
    const store = new InMemoryAssistantStore();
    const unknownId = "00000000-0000-4000-8000-0000000000ff";
    await expect(
      store.setConversationPinned({ orgId, actorId, conversationId: unknownId, pinned: true }),
    ).resolves.toBeNull();
    await expect(
      store.renameConversation({ orgId, actorId, conversationId: unknownId, title: "X" }),
    ).resolves.toBeNull();
    await expect(
      store.deleteConversation({ orgId, actorId, conversationId: unknownId }),
    ).resolves.toBe(false);
  });
});

describe("assistant conversation tools", () => {
  it("exposes the conversation-management tools with correct scope gating", () => {
    const tools = createAssistantToolDefinitions({
      store: new InMemoryAssistantStore(),
      orchestrator: orchestratorStub,
    });
    const byId = new Map(tools.map((tool) => [tool.id, tool]));
    expect(byId.get("assistant.conversations.list")?.permission).toBe("assistant.read");
    expect(byId.get("assistant.conversations.list")?.sideEffects).toBe("read");
    expect(byId.get("assistant.conversation.pin")?.permission).toBe("assistant.write");
    expect(byId.get("assistant.conversation.unpin")?.permission).toBe("assistant.write");
    expect(byId.get("assistant.conversation.rename")?.permission).toBe("assistant.write");
    expect(byId.get("assistant.conversation.delete")?.confirmationRequired).toBe(true);
  });

  it("lists, pins, unpins, and renames conversations through the tool registry", async () => {
    const store = new InMemoryAssistantStore();
    const registry = createToolRegistry();
    registerAssistantTools(registry, { store, orchestrator: orchestratorStub });
    const conversation = await store.createConversation({ actor, title: "Working session" });

    const pinned = await registry.invoke<AssistantConversation>(
      "assistant.conversation.pin",
      { conversationId: conversation.id },
      { actor },
    );
    expect(pinned.ok && pinned.output.pinnedAt).not.toBeNull();

    const listed = await registry.invoke<AssistantConversationListPage>(
      "assistant.conversations.list",
      { pinnedOnly: true, limit: 10 },
      { actor },
    );
    expect(listed.ok ? listed.output.items.map((item) => item.id) : []).toEqual([
      conversation.id,
    ]);

    const renamed = await registry.invoke<AssistantConversation>(
      "assistant.conversation.rename",
      { conversationId: conversation.id, title: "Renamed session" },
      { actor },
    );
    expect(renamed.ok ? renamed.output.title : null).toBe("Renamed session");

    const unpinned = await registry.invoke<AssistantConversation>(
      "assistant.conversation.unpin",
      { conversationId: conversation.id },
      { actor },
    );
    expect(unpinned.ok ? unpinned.output.pinnedAt : "x").toBeNull();
  });

  it("fails the pin tool for an unknown conversation", async () => {
    const store = new InMemoryAssistantStore();
    const registry = createToolRegistry();
    registerAssistantTools(registry, { store, orchestrator: orchestratorStub });

    const result = await registry.invoke(
      "assistant.conversation.pin",
      { conversationId: "00000000-0000-4000-8000-0000000000ff" },
      { actor },
    );
    expect(result.ok).toBe(false);
  });
});
