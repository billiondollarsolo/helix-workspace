import type { Actor, ChatRequest, JsonObject, ToolDefinition } from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { openAIRequest } from "../ai/providers/openai-tools.js";
import { AllowAllToolAccessPolicy } from "../permissions/tool-access.js";
import { createToolRegistry } from "../tool-registry.js";
import { InMemoryConfirmationGate, InMemoryPendingActionStore } from "../tools/registry.js";
import { AssistantOrchestrator } from "./orchestrator.js";
import { InMemoryAssistantStore } from "./store.js";
import { assistantChatBodySchema, registerAssistantTools } from "./tools.js";
import type { AssistantStreamEvent } from "./types.js";

const actor: Actor = {
  id: "10000000-0000-4000-8000-000000000001",
  orgId: "20000000-0000-4000-8000-000000000001",
  type: "user",
  scopes: ["assistant.read", "assistant.write"],
};
function tool(
  id: string,
  handler: ToolDefinition["handler"],
  sideEffects: ToolDefinition["sideEffects"] = "read",
): ToolDefinition {
  return {
    id,
    description: id,
    permission: "assistant.read",
    sideEffects,
    handler,
    inputSchema: { parse: (value) => value, toJsonSchema: () => ({ type: "object" }) },
    outputSchema: { parse: (value) => value, toJsonSchema: () => ({ type: "object" }) },
  };
}
const response = (
  message: string,
  toolCalls?: { id: string; callId: string; input?: JsonObject; error?: string }[],
) => ({
  message,
  model: "test",
  providerId: "test",
  ...(toolCalls === undefined ? {} : { toolCalls }),
});

describe("Assistant shared native continuation", () => {
  it("requires fresh approval for each write without resetting the original model or iteration budget", async () => {
    const confirmationGate = new InMemoryConfirmationGate(new InMemoryPendingActionStore());
    const tools = createToolRegistry({
      accessPolicy: new AllowAllToolAccessPolicy(),
      confirmationGate,
      resolvePendingPrincipal: async (record) => ({ actor: record.requesterPrincipal }),
    });
    const store = new InMemoryAssistantStore();
    const write = vi.fn(async () => ({ classification: "standard", saved: true }));
    tools.register(tool("chat.write", write, "write"));
    let configuredRounds = 2;
    const getMaxToolRounds = vi.fn(() => configuredRounds);
    const requests: ChatRequest[] = [];
    const assistant = new AssistantOrchestrator({
      store,
      tools,
      confirmationGate,
      getMaxToolRounds,
      listModels: () => ({
        models: ["original", "later"].map((id) => ({
          id,
          label: id,
          model: id,
          providerId: "test",
        })),
      }),
      ai: {
        chat: async (request) => {
          requests.push(request);
          expect(request.model).toBe("original");
          expect(
            request.messages.some((message) => message.content === "Unrelated later question"),
          ).toBe(false);
          if (requests.length < 3)
            return response("Approve this write", [
              { id: "chat.write", callId: `write-${String(requests.length)}` },
            ]);
          expect(request.tools).toEqual([]);
          return response("Both approved changes are complete.");
        },
      },
    });
    const first = await assistant.sendMessage({
      actor,
      content: "Two changes",
      modelId: "original",
      toolGroups: ["chat"],
      metadata: { assistantTurn: { maxToolRounds: 256, toolGroups: ["admin"] } },
    });
    expect(write).not.toHaveBeenCalled();
    configuredRounds = 256;
    await store.appendMessage({
      orgId: actor.orgId,
      conversationId: first.conversation.id,
      actorId: actor.id,
      role: "user",
      content: "Unrelated later question",
      metadata: { effectiveClassification: "standard" },
    });
    await store.appendMessage({
      orgId: actor.orgId,
      conversationId: first.conversation.id,
      role: "assistant",
      content: "Unrelated answer",
      metadata: { selectedModelId: "later", effectiveClassification: "standard" },
    });
    const second = await assistant.approvePendingTool({
      actor,
      conversationId: first.conversation.id,
      pendingId: first.pendingConfirmations[0]?.id ?? "missing-first-pending",
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(second.pendingConfirmations).toHaveLength(1);
    const final = await assistant.approvePendingTool({
      actor,
      conversationId: first.conversation.id,
      pendingId: second.pendingConfirmations[0]?.id ?? "missing-second-pending",
    });
    expect(write).toHaveBeenCalledTimes(2);
    expect(final.pendingConfirmations).toEqual([]);
    expect(final.response.metadata.assistantTurn).toMatchObject({
      maxToolRounds: 2,
      usedToolRounds: 2,
      toolGroups: ["chat"],
    });
    expect(getMaxToolRounds).toHaveBeenCalledTimes(1);
    await expect(
      assistant.approvePendingTool({
        actor,
        conversationId: first.conversation.id,
        pendingId: first.pendingConfirmations[0]?.id ?? "missing-first-pending",
      }),
    ).rejects.toThrow();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("samples the saved iteration setting once per turn and validates its bounds", async () => {
    let rounds = 1;
    const getMaxToolRounds = vi.fn(() => rounds);
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    const handler = vi.fn(async () => ({ classification: "standard" }));
    tools.register(tool("chat.read", handler));
    const ai = {
      chat: vi.fn(async (request: ChatRequest) =>
        response(
          request.tools?.length ? "" : "Finished",
          request.tools?.length
            ? [{ id: "chat.read", callId: `call-${String(handler.mock.calls.length)}` }]
            : undefined,
        ),
      ),
    };
    const assistant = new AssistantOrchestrator({
      store: new InMemoryAssistantStore(),
      tools,
      ai,
      getMaxToolRounds,
    });
    expect(
      (await assistant.sendMessage({ actor, content: "Read", toolGroups: ["chat"] })).toolCalls,
    ).toHaveLength(1);
    rounds = 2;
    expect(
      (await assistant.sendMessage({ actor, content: "Read", toolGroups: ["chat"] })).toolCalls,
    ).toHaveLength(2);
    expect(getMaxToolRounds).toHaveBeenCalledTimes(2);
    expect(ai.chat).toHaveBeenCalledTimes(5);
    rounds = 257;
    await expect(assistant.sendMessage({ actor, content: "Read" })).rejects.toThrow("1 to 256");
    expect(ai.chat).toHaveBeenCalledTimes(5);
  });

  it("feeds malformed and recoverable failures back with their native IDs before a successful retry", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    const handler = vi.fn(async () => {
      if (handler.mock.calls.length === 1)
        throw Object.assign(new Error("Try a different query."), { statusCode: 400 });
      return { classification: "standard", answer: "Found it" };
    });
    tools.register(tool("chat.read", handler));
    const requests: ChatRequest[] = [];
    const assistant = new AssistantOrchestrator({
      store: new InMemoryAssistantStore(),
      tools,
      ai: {
        chat: async (request) => {
          requests.push(request);
          return requests.length <= 3
            ? response("", [
                {
                  id: "chat.read",
                  callId: `native-${String(requests.length)}`,
                  ...(requests.length === 1
                    ? { error: "Invalid JSON object arguments." }
                    : { input: {} }),
                },
              ])
            : response("Recovered");
        },
      },
    });
    const events: AssistantStreamEvent[] = [];
    for await (const event of assistant.sendMessageStream({
      actor,
      content: "Read",
      toolGroups: ["chat"],
    }))
      events.push(event);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(
      requests[1]?.messages.some(
        (message) => message.toolCallId === "native-1" && message.content.includes("Invalid JSON"),
      ),
    ).toBe(true);
    expect(
      requests[2]?.messages.some(
        (message) =>
          message.toolCallId === "native-2" && message.content.includes('"statusCode":400'),
      ),
    ).toBe(true);
    expect(events.filter((event) => event.type === "tool").map((event) => event.status)).toEqual([
      "running",
      "failed",
      "running",
      "failed",
      "running",
      "executed",
    ]);
    expect(JSON.stringify(events.filter((event) => event.type === "tool"))).not.toContain(
      "Found it",
    );
    const turn = events.find((event) => event.type === "final")?.turn;
    expect(turn?.response.toolActivity).toHaveLength(3);
    expect(
      (await assistant.getConversation(actor, turn?.conversation.id ?? "missing-turn")).messages.at(
        -1,
      )?.toolActivity,
    ).toHaveLength(3);
  });

  it("executes native calls sequentially and blocks later public egress after a restricted read", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    const privateRead = vi.fn(async () => ({ classification: "restricted" }));
    const external = vi.fn(async () => ({}));
    tools.register(tool("chat.private", privateRead));
    tools.register(tool("web.search", external));
    let calls = 0;
    const assistant = new AssistantOrchestrator({
      store: new InMemoryAssistantStore(),
      tools,
      webSearchEnabled: () => true,
      ai: {
        chat: async (request) => {
          if (calls++ === 0)
            return response("", [
              { id: "chat.private", callId: "private" },
              { id: "web.search", callId: "external" },
            ]);
          expect(request.classification).toBe("restricted");
          return response("Kept private");
        },
      },
    });
    const turn = await assistant.sendMessage({
      actor,
      content: "Check",
      webSearch: true,
      toolGroups: ["chat"],
    });
    expect(privateRead).toHaveBeenCalledTimes(1);
    expect(external).not.toHaveBeenCalled();
    expect(turn.toolCalls.map((call) => call.status)).toEqual(["executed", "skipped"]);
  });

  it("checks abort between native calls without executing the second handler or saving completion", async () => {
    const abort = new AbortController();
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    const store = new InMemoryAssistantStore();
    tools.register(
      tool("chat.first", async () => {
        abort.abort();
        return {};
      }),
    );
    const second = vi.fn(async () => ({}));
    tools.register(tool("chat.second", second));
    const assistant = new AssistantOrchestrator({
      store,
      tools,
      ai: {
        chat: async () =>
          response("", [
            { id: "chat.first", callId: "first" },
            { id: "chat.second", callId: "second" },
          ]),
      },
    });
    await expect(
      assistant.sendMessage({ actor, content: "Check", signal: abort.signal }),
    ).rejects.toThrow();
    expect(second).not.toHaveBeenCalled();
    const conversation = (
      await store.listConversations({ orgId: actor.orgId, actorId: actor.id, limit: 10 })
    ).items[0];
    expect(
      (
        await store.listMessages({
          orgId: actor.orgId,
          conversationId: conversation?.id ?? "missing-conversation",
        })
      ).some((message) => message.role === "assistant"),
    ).toBe(false);
  });

  it.each([true, false])(
    "resumes approval=%s with saved selection, sources, native correlation and the remaining turn budget",
    async (approve) => {
      const confirmationGate = new InMemoryConfirmationGate(new InMemoryPendingActionStore());
      const tools = createToolRegistry({
        accessPolicy: new AllowAllToolAccessPolicy(),
        confirmationGate,
        resolvePendingPrincipal: async (record) => ({ actor: record.requesterPrincipal }),
      });
      const write = vi.fn(async () => ({ classification: "standard", saved: true }));
      tools.register(tool("chat.write", write, "write"));
      tools.register(
        tool("web.search", async () => ({
          provider: "searxng",
          results: [
            {
              id: "source",
              title: "Documentation",
              url: "https://example.com/docs",
              snippet: "Public evidence",
            },
          ],
        })),
      );
      tools.register(tool("admin.secret", async () => ({})));
      const requests: ChatRequest[] = [];
      const assistant = new AssistantOrchestrator({
        store: new InMemoryAssistantStore(),
        tools,
        confirmationGate,
        maxToolRounds: 2,
        webSearchEnabled: () => true,
        classifyToolResult: async () => "standard",
        ai: {
          chat: async (request) => {
            requests.push(request);
            if (requests.length === 1)
              return response("", [
                { id: "web.search", callId: "search" },
                { id: "chat.write", callId: "write" },
              ]);
            if (requests.length === 2) {
              expect(request.tools).toEqual(expect.arrayContaining(["chat.write", "web.search"]));
              expect(request.tools).not.toContain("admin.secret");
              expect(request.messages[0]?.content).toContain("America/New_York");
              const native = openAIRequest(request).body.messages;
              expect(native.filter((message) => message.tool_call_id === "write")).toHaveLength(1);
              expect(
                JSON.stringify(native.find((message) => message.tool_call_id === "write")),
              ).toContain(approve ? "saved" : "cancelled");
              return response("", [{ id: "web.search", callId: "next-search" }]);
            }
            expect(request.tools).toEqual([]);
            return response("Complete [Documentation](https://example.com/docs)");
          },
        },
      });
      const first = await assistant.sendMessage({
        actor,
        content: "Read then write",
        webSearch: true,
        toolGroups: ["chat"],
        metadata: { timeZone: "America/New_York" },
      });
      const input = {
        actor,
        conversationId: first.conversation.id,
        pendingId: first.pendingConfirmations[0]?.id ?? "missing-first-pending",
      };
      const turn = approve
        ? await assistant.approvePendingTool(input)
        : await assistant.cancelPendingTool(input);
      expect(write).toHaveBeenCalledTimes(approve ? 1 : 0);
      expect(requests).toHaveLength(3);
      expect(turn.sources).toMatchObject([{ type: "web.search", url: "https://example.com/docs" }]);
      expect(turn.response.sources).toMatchObject([{ url: "https://example.com/docs" }]);
      expect(turn.response.metadata.assistantTurn).toMatchObject({
        usedToolRounds: 2,
        webSearch: true,
        toolGroups: ["chat"],
      });
      expect(
        (await assistant.getConversation(actor, turn.conversation.id)).messages.at(-1)?.sources,
      ).toHaveLength(1);
    },
  );

  it("lists only authorized group counts and requires explicit admin selection", async () => {
    const tools = createToolRegistry({
      accessPolicy: { can: async (_actor, permission) => permission !== "admin.users" },
    });
    for (const id of [
      "mail.read",
      "chat.read",
      "admin.read",
      "agent.read",
      "app.passwords.list",
      "webhooks.list",
      "web.search",
      "assistant.hidden",
    ])
      tools.register(tool(id, async () => ({})));
    tools.register({ ...tool("admin.denied", async () => ({})), permission: "admin.users" });
    const store = new InMemoryAssistantStore();
    const requests: ChatRequest[] = [];
    const assistant = new AssistantOrchestrator({
      store,
      tools,
      ai: {
        chat: async (request) => {
          requests.push(request);
          return response("Done");
        },
      },
    });
    registerAssistantTools(tools, { store, orchestrator: assistant });
    const listed = await tools.invoke("assistant.tools.list", {}, { actor });
    expect(listed.ok && listed.output).toMatchObject({
      groups: expect.arrayContaining([
        { id: "admin", label: "Administration", count: 3, defaultEnabled: false },
      ]),
    });
    const defaultTurn = await assistant.sendMessage({ actor, content: "Normal" });
    expect(defaultTurn.response.metadata.assistantTurn).toMatchObject({ maxToolRounds: 128 });
    expect(requests[0]?.tools).not.toContain("admin.read");
    await assistant.sendMessage({ actor, content: "Admin", toolGroups: ["admin"] });
    expect(requests[1]?.tools).toEqual(
      expect.arrayContaining(["admin.read", "agent.read", "app.passwords.list", "platform.ping"]),
    );
    expect(requests[1]?.tools).not.toContain("admin.denied");
    expect(requests[1]?.tools).not.toContain("mail.read");
    expect(
      assistantChatBodySchema.safeParse({ message: "Hello", toolGroups: ["system"] }).success,
    ).toBe(false);
  });
});
