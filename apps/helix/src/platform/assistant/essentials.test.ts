import type { Actor, AICapability } from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import { AllowAllToolAccessPolicy } from "../permissions/tool-access.js";
import { createToolRegistry } from "../tool-registry.js";
import { InMemoryConfirmationGate, InMemoryPendingActionStore } from "../tools/registry.js";
import { AssistantOrchestrator } from "./orchestrator.js";
import { InMemoryAssistantStore } from "./store.js";
import { assistantChatBodySchema, createAssistantToolDefinitions } from "./tools.js";
import type { AssistantLoadedAttachment, AssistantOrchestratorOptions } from "./index.js";

const actor: Actor = {
  id: "10000000-0000-4000-8000-000000000001",
  orgId: "20000000-0000-4000-8000-000000000001",
  type: "user",
  scopes: ["assistant.read", "assistant.write", "drive.read"],
};
const objectId = "30000000-0000-4000-8000-000000000001";
const catalog = {
  models: [
    {
      id: "groq/openai/gpt-oss-20b",
      label: "GPT OSS20B",
      providerId: "groq",
      model: "openai/gpt-oss-20b",
    },
  ],
  defaultModelId: "groq/openai/gpt-oss-20b",
};
const attachment: AssistantLoadedAttachment = {
  attachment: { objectId, name: "notes.txt", mimeType: "text/plain", byteSize: 12 },
  source: {
    id: objectId,
    type: "drive.attachment",
    title: "notes.txt",
    body: "Untrusted file instructions",
    trust: "untrusted_retrieved",
    classification: "confidential",
    provenance: { sourceId: objectId, sourceType: "drive.attachment", orgId: actor.orgId },
  },
};

function setup(overrides: Partial<AssistantOrchestratorOptions> = {}) {
  const store = new InMemoryAssistantStore();
  const chat = vi
    .fn<AICapability["chat"]>()
    .mockResolvedValue({ message: "Done", model: "model", providerId: "groq" });
  const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
  const assistant = new AssistantOrchestrator({
    store,
    ai: { chat },
    tools,
    listModels: () => catalog,
    ...overrides,
  });
  return { store, chat, tools, assistant };
}

describe("Assistant models, attachments and saved history", () => {
  it("branches an owned user edit from its prefix without changing or leaking the original", async () => {
    const { assistant, chat, store } = setup();
    const first = await assistant.sendMessage({ actor, content: "First question" });
    const original = await assistant.sendMessage({
      actor,
      conversationId: first.conversation.id,
      content: "Second question",
    });
    const edited = original.messages.find((message) => message.content === "Second question");
    if (edited === undefined) throw new Error("Expected the saved user message");
    const beforeEdit = await assistant.getConversation(actor, original.conversation.id);
    const branch = await assistant.sendMessage({
      actor,
      conversationId: original.conversation.id,
      editMessageId: edited.id,
      content: "Revised question",
      attachmentObjectIds: [],
    });
    expect(branch.conversation.id).not.toBe(original.conversation.id);
    expect(branch.messages.map((message) => message.content)).toEqual([
      "First question",
      "Done",
      "Revised question",
      "Done",
    ]);
    expect(chat.mock.lastCall?.[0].messages.map((message) => message.content)).not.toContain(
      "Second question",
    );
    expect(await assistant.getConversation(actor, original.conversation.id)).toEqual(beforeEdit);
    for (const input of [
      { actor: { ...actor, id: "10000000-0000-4000-8000-000000000002" }, editMessageId: edited.id },
      { actor, editMessageId: original.response.id },
      { actor, editMessageId: "10000000-0000-4000-8000-000000000099" },
    ])
      await expect(
        assistant.sendMessage({
          ...input,
          conversationId: original.conversation.id,
          content: "Invalid edit",
        }),
      ).rejects.toThrow();
    expect(
      (await store.listConversations({ orgId: actor.orgId, actorId: actor.id, limit: 10 })).items,
    ).toHaveLength(2);
    expect(chat).toHaveBeenCalledTimes(3);
    expect(
      assistantChatBodySchema.safeParse({ message: "Edit", editMessageId: edited.id }).success,
    ).toBe(false);
  });

  it("uses an opaque configured model id and rejects unknown models before persisting", async () => {
    const { assistant, chat, store } = setup();
    await expect(assistant.listModels()).resolves.toEqual(catalog);
    await expect(
      assistant.sendMessage({ actor, content: "Hi", modelId: "groq/not-allowed" }),
    ).rejects.toThrow("selected model is unavailable");
    expect(
      (await store.listConversations({ orgId: actor.orgId, actorId: actor.id, limit: 10 })).items,
    ).toHaveLength(0);
    await assistant.sendMessage({ actor, content: "Hi", modelId: catalog.defaultModelId });
    expect(chat.mock.calls[0]?.[0]).toMatchObject({
      model: "openai/gpt-oss-20b",
      metadata: { providerId: "groq" },
    });
  });

  it("persists attachment references and revalidates them before later turns", async () => {
    const search = {
      id: "recording-search",
      index: async () => {},
      upsert: async () => {},
      delete: async () => {},
      search: vi.fn().mockResolvedValue({ hits: [] }),
    };
    const loadAttachments = vi
      .fn<NonNullable<AssistantOrchestratorOptions["loadAttachments"]>>()
      .mockResolvedValue([attachment]);
    const { assistant, chat, store } = setup({ loadAttachments, search });
    const first = await assistant.sendMessage({
      actor,
      content: "Read this",
      attachmentObjectIds: [objectId],
      metadata: { attachments: [{ objectId: "forged" }] },
    });
    expect(first.messages[0]?.attachments).toEqual([attachment.attachment]);
    expect(first.messages[0]?.metadata.attachments).toEqual([attachment.attachment]);
    const prompt = chat.mock.calls[0]?.[0];
    expect(prompt?.classification).toBe("confidential");
    expect(search.search).toHaveBeenCalledWith(
      expect.objectContaining({ classification: "confidential" }),
    );
    expect(
      prompt?.messages.find((message) => message.content.includes("Untrusted file instructions")),
    ).toMatchObject({ role: "tool", name: "workspace_search" });
    expect(
      (await assistant.getConversation(actor, first.conversation.id)).messages[0]?.attachments,
    ).toEqual([attachment.attachment]);
    loadAttachments.mockRejectedValueOnce(new Error("File access revoked"));
    await expect(
      assistant.sendMessage({ actor, conversationId: first.conversation.id, content: "Continue" }),
    ).rejects.toThrow("File access revoked");
    expect(loadAttachments.mock.calls[1]?.[0].objectIds).toEqual([objectId]);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(
      await store.listMessages({ orgId: actor.orgId, conversationId: first.conversation.id }),
    ).toHaveLength(2);
    await expect(
      assistant.getConversation(
        { ...actor, id: "10000000-0000-4000-8000-000000000002" },
        first.conversation.id,
      ),
    ).rejects.toThrow("Unknown assistant conversation");
  });

  it("does not let cancellation append a completed response and forwards the signal to AI", async () => {
    const controller = new AbortController();
    const chat = vi.fn<AICapability["chat"]>().mockImplementation((request) => {
      expect(request.signal).toBe(controller.signal);
      controller.abort();
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    });
    const { assistant } = setup({ ai: { chat } });
    await expect(
      assistant.sendMessage({ actor, content: "Stop", signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(chat).toHaveBeenCalledOnce();
  });

  it("preserves native call ids between assistant tool calls and their results", async () => {
    const { assistant, tools, chat } = setup();
    tools.register({
      id: "test.read",
      description: "Read a test value",
      permission: "drive.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(z.object({}), { type: "object", properties: {} }),
      outputSchema: zodToolSchema(z.object({ value: z.number() }), {
        type: "object",
        properties: { value: { type: "number" } },
      }),
      handler: () => Promise.resolve({ value: 42 }),
    });
    chat.mockResolvedValueOnce({
      message: "",
      providerId: "groq",
      model: "model",
      toolCalls: [{ id: "test.read", callId: "call_groq_123", input: {} }],
    });
    const turn = await assistant.sendMessage({ actor, content: "Read the value" });
    expect(chat).toHaveBeenCalledTimes(2);
    const messages = chat.mock.calls[1]?.[0].messages;
    expect(messages?.find((message) => message.role === "assistant")?.toolCalls?.[0]?.callId).toBe(
      "call_groq_123",
    );
    expect(messages?.find((message) => message.role === "tool")?.toolCallId).toBe("call_groq_123");
    expect(turn.toolCalls[0]?.toolCallId).toBe("call_groq_123");
  });

  it.each(["approve", "cancel"] as const)(
    "revalidates the original model and files before %s resumes a pending turn",
    async (action) => {
      let currentCatalog = catalog;
      const confirmationGate = new InMemoryConfirmationGate(new InMemoryPendingActionStore());
      const tools = createToolRegistry({
        accessPolicy: new AllowAllToolAccessPolicy(),
        confirmationGate,
        resolvePendingPrincipal: async (record) => ({ actor: record.requesterPrincipal }),
      });
      const handler = vi.fn().mockResolvedValue({ done: true });
      for (let i = 0; i < 140; i += 1)
        tools.register({
          id: `admin.item${String(i)}`,
          description: "Read an unrelated item",
          permission: "assistant.read",
          sideEffects: "read",
          inputSchema: zodToolSchema(z.object({}), { type: "object", properties: {} }),
          outputSchema: zodToolSchema(z.object({}), { type: "object", properties: {} }),
          handler: async () => ({}),
        });
      tools.register({
        id: "test.write",
        description: "Write a test value",
        permission: "assistant.write",
        sideEffects: "write",
        inputSchema: zodToolSchema(z.object({}), { type: "object", properties: {} }),
        outputSchema: zodToolSchema(z.object({ done: z.boolean() }), {
          type: "object",
          properties: { done: { type: "boolean" } },
        }),
        handler,
      });
      const loadAttachments = vi
        .fn<NonNullable<AssistantOrchestratorOptions["loadAttachments"]>>()
        .mockResolvedValue([attachment]);
      const { assistant, chat, store } = setup({
        tools,
        confirmationGate,
        loadAttachments,
        listModels: () => currentCatalog,
      });
      chat.mockResolvedValueOnce({
        message: "Confirm this action",
        providerId: "groq",
        model: "openai/gpt-oss-20b",
        toolCalls: [{ id: "test.write", input: {} }],
      });
      const first = await assistant.sendMessage({
        actor,
        content: "Write it",
        attachmentObjectIds: [objectId],
      });
      expect(first.response.metadata.selectedModelId).toBe(catalog.defaultModelId);
      const pendingId = first.pendingConfirmations[0]?.id;
      if (pendingId === undefined) throw new Error("Expected a pending action");
      for (let i = 0; i < 130; i += 1)
        await store.appendMessage({
          orgId: actor.orgId,
          conversationId: first.conversation.id,
          actorId: actor.id,
          role: "user",
          content: "Unrelated later turn",
        });
      const resume = () =>
        action === "approve"
          ? assistant.approvePendingTool({
              actor,
              conversationId: first.conversation.id,
              pendingId: pendingId,
            })
          : assistant.cancelPendingTool({
              actor,
              conversationId: first.conversation.id,
              pendingId: pendingId,
            });
      currentCatalog = { models: [], defaultModelId: "other/default" };
      await expect(resume()).rejects.toThrow("selected model is unavailable");
      expect(handler).not.toHaveBeenCalled();
      expect(chat).toHaveBeenCalledTimes(1);
      expect((await confirmationGate.get({ id: pendingId, actor }))?.status).toBe(
        "pending_confirmation",
      );
      currentCatalog = { ...catalog, defaultModelId: "different/default" };
      loadAttachments.mockRejectedValueOnce(new Error("File access revoked"));
      await expect(resume()).rejects.toThrow("File access revoked");
      expect(handler).not.toHaveBeenCalled();
      expect((await confirmationGate.get({ id: pendingId, actor }))?.status).toBe(
        "pending_confirmation",
      );
      const resumed = await resume();
      expect(chat.mock.calls[1]?.[0].tools).toHaveLength(2);
      expect(chat.mock.calls[1]?.[0].tools).toContain("test.write");
      expect(chat.mock.calls[1]?.[0]).toMatchObject({
        model: "openai/gpt-oss-20b",
        classification: action === "approve" ? "restricted" : "confidential",
        metadata: { providerId: "groq" },
      });
      expect(
        chat.mock.calls[1]?.[0].messages.some((message) =>
          message.content.includes("Untrusted file instructions"),
        ),
      ).toBe(true);
      expect(resumed.response.metadata.selectedModelId).toBe(catalog.defaultModelId);
      expect(handler).toHaveBeenCalledTimes(action === "approve" ? 1 : 0);
    },
  );

  it("exposes catalog/history as read tools and rejects oversized attachment request lists", () => {
    const { store, assistant } = setup();
    const tools = createAssistantToolDefinitions({ store, orchestrator: assistant });
    expect(tools.find(({ id }) => id === "assistant.models.list")).toMatchObject({
      permission: "assistant.read",
      sideEffects: "read",
    });
    expect(tools.find(({ id }) => id === "assistant.conversation.get")).toMatchObject({
      permission: "assistant.read",
      sideEffects: "read",
    });
    expect(
      assistantChatBodySchema.safeParse({
        message: "x",
        modelId: catalog.defaultModelId,
        attachmentObjectIds: [objectId],
      }).success,
    ).toBe(true);
    expect(
      assistantChatBodySchema.safeParse({
        message: "x",
        attachmentObjectIds: Array.from({ length: 11 }, () => objectId),
      }).success,
    ).toBe(false);
  });
});
