import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { InMemoryMemoryStore } from "../ai/memory/in-memory.js";
import { registerMemoryTools } from "../ai/memory/tools.js";
import { AllowAllToolAccessPolicy } from "../permissions/tool-access.js";
import { createToolRegistry } from "../tool-registry.js";
import { InMemoryConfirmationGate, InMemoryPendingActionStore } from "../tools/registry.js";
import { registerAskUserTool } from "./ask-user.js";
import { registerChatRecallTools } from "./chats.js";
import { registerContextTools } from "./context-tools.js";
import { AssistantOrchestrator } from "./orchestrator.js";
import { InMemoryAssistantStore } from "./store.js";
import { registerTaskTools } from "./tasks.js";
import { untrustedContextMessages, withSourceImages } from "./orchestrator-prompt.js";

const actor: Actor = {
  id: "10000000-0000-4000-8000-000000000001",
  orgId: "20000000-0000-4000-8000-000000000001",
  type: "user",
  scopes: ["assistant.read", "assistant.write", "assistant.memory"],
};

describe("assistant native Open WebUI-style tools", () => {
  it("pages turn sources, maintains a checklist, and requires memory opt-in for writes", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    const memory = new InMemoryMemoryStore();
    registerMemoryTools(tools, memory);
    registerContextTools(tools);
    registerTaskTools(tools);
    const chat = async (request: { readonly messages: readonly { readonly role: string }[] }) => {
      const last = request.messages.at(-1);
      if (last?.role === "user")
        return {
          message: "",
          model: "test",
          providerId: "test",
          toolCalls: [
            { id: "context.view", callId: "v1", input: { sourceId: "note-1", limit: 12 } },
            { id: "tasks.create", callId: "t1", input: { titles: ["Read note", "Remember ZIP"] } },
            { id: "memory.add", callId: "m1", input: { content: "ZIP 20882" } },
          ],
        };
      return { message: "Done", model: "test", providerId: "test" };
    };
    const assistant = new AssistantOrchestrator({
      store: new InMemoryAssistantStore(),
      tools,
      memory,
      loadAttachments: async () => [
        {
          attachment: {
            objectId: "note-1",
            name: "note.txt",
            mimeType: "text/plain",
            byteSize: 20,
          },
          source: {
            id: "note-1",
            type: "drive.attachment",
            trust: "untrusted_retrieved",
            classification: "standard",
            title: "note.txt",
            body: "Gaithersburg forecast details",
            provenance: { sourceId: "note-1", sourceType: "drive.attachment", orgId: actor.orgId },
          },
        },
      ],
      ai: { chat },
    });
    const denied = await assistant.sendMessage({
      actor,
      content: "Plan the weather lookup",
      attachmentObjectIds: ["30000000-0000-4000-8000-000000000001"],
    });
    expect(denied.toolCalls.map((call) => [call.toolId, call.status])).toEqual([
      ["context.view", "executed"],
      ["tasks.create", "executed"],
      ["memory.add", "failed"],
    ]);
    expect(denied.toolCalls[0]?.output).toMatchObject({ content: "Gaithersburg" });
    expect(denied.toolCalls[2]?.error).toMatch(/Memory is off/);
  });

  it("recalls other chats after memory opt-in and collects ask.user answers on approve", async () => {
    const confirmationGate = new InMemoryConfirmationGate(new InMemoryPendingActionStore());
    const tools = createToolRegistry({
      accessPolicy: new AllowAllToolAccessPolicy(),
      confirmationGate,
      resolvePendingPrincipal: async (record) => ({ actor: record.requesterPrincipal }),
    });
    registerChatRecallTools(tools);
    registerAskUserTool(tools);
    const store = new InMemoryAssistantStore();
    const other = await store.createConversation({ actor, title: "Atlas renewal" });
    await store.appendMessage({
      orgId: actor.orgId,
      conversationId: other.id,
      actorId: actor.id,
      role: "assistant",
      content: "Atlas ZIP is 20882.",
    });
    let users = 0;
    const chat = async (request: { readonly messages: readonly { readonly role: string }[] }) => {
      const last = request.messages.at(-1);
      if (last?.role === "user") {
        users += 1;
        return {
          message: "",
          model: "test",
          providerId: "test",
          toolCalls:
            users === 1
              ? [{ id: "chats.search", callId: "s1", input: { query: "Atlas" } }]
              : [
                  { id: "chats.search", callId: "s1", input: { query: "Atlas" } },
                  {
                    id: "ask.user",
                    callId: "a1",
                    input: {
                      question: "Confirm the ZIP",
                      fields: [{ id: "zip", label: "ZIP" }],
                    },
                  },
                ],
        };
      }
      return { message: "Noted", model: "test", providerId: "test" };
    };
    const assistant = new AssistantOrchestrator({
      store,
      tools,
      confirmationGate,
      ai: { chat },
    });
    const denied = await assistant.sendMessage({ actor, content: "Recall Atlas" });
    expect(denied.toolCalls[0]).toMatchObject({ toolId: "chats.search", status: "failed" });
    const opted = await assistant.sendMessage({
      actor,
      content: "Recall Atlas",
      memoryOptIn: true,
    });
    expect(opted.toolCalls[0]?.status).toBe("executed");
    const listed =
      opted.toolCalls[0]?.output &&
      typeof opted.toolCalls[0].output === "object" &&
      "conversations" in opted.toolCalls[0].output &&
      Array.isArray(opted.toolCalls[0].output.conversations)
        ? opted.toolCalls[0].output.conversations
        : [];
    expect(listed).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: other.id, title: "Atlas renewal" })]),
    );
    expect(listed.map((item) => (item as { id?: string }).id)).not.toContain(opted.conversation.id);
    expect(opted.toolCalls[1]?.status).toBe("pending_confirmation");
    const pendingId = opted.pendingConfirmations[0]?.id;
    if (pendingId === undefined) throw new Error("expected ask.user pending");
    const answered = await assistant.approvePendingTool({
      actor,
      conversationId: opted.conversation.id,
      pendingId,
      metadata: { answers: { zip: "20882" } },
    });
    expect(answered.toolCalls[0]?.output).toMatchObject({
      question: "Confirm the ZIP",
      answers: { zip: "20882" },
    });
  });

  it("puts image bytes on the last user message instead of untrusted tool JSON", () => {
    const source = {
      id: "img",
      type: "drive.attachment",
      trust: "untrusted_retrieved" as const,
      classification: "standard" as const,
      provenance: { sourceId: "img", sourceType: "drive.attachment", orgId: actor.orgId },
      media: { mimeType: "image/png", data: "abc" },
    };
    expect(
      withSourceImages(
        [
          { role: "system", content: "sys" },
          { role: "user", content: "Look" },
        ],
        [source],
      )[1],
    ).toMatchObject({
      role: "user",
      images: [{ mimeType: "image/png", data: "abc" }],
    });
    expect(untrustedContextMessages([source], [])[0]?.content.includes("abc")).toBe(false);
  });
});
