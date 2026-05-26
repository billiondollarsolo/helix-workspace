import { describe, expect, it } from "vitest";
import type {
  AICallContext,
  AICapability,
  Actor,
  ChatRequest,
  ChatResponse,
  JsonObject,
  LLMProviderCapability,
  ToolDefinition,
} from "@helix/sdk-types";
import {
  AICostLimitExceededError,
  InMemoryAICostLimiter,
  aiCentsToUsdMicros,
  createAICostGuard,
} from "../ai/costs/index.js";
import type { ForgetCriteria, MemoryInput, MemoryItem, MemoryStore } from "../ai/memory/index.js";
import { AIRouter } from "../ai/routing.js";
import type { ChatStore } from "../chat/store.js";
import type {
  ChatMessageRecord,
  ChatReactionRecord,
  ChatReadReceiptRecord,
  ChatRoomRecord,
  ChatSearchHit,
} from "../chat/types.js";
import { registerChatTools } from "../chat/tools.js";
import type { DriveStore } from "../drive/store.js";
import type {
  DriveEntryRecord,
  DriveSearchHit,
  DriveUploadRecord,
  DriveVersionRecord,
} from "../drive/types.js";
import { registerDriveTools } from "../drive/tools.js";
import { AllowAllToolAccessPolicy } from "../permissions/tool-access.js";
import type {
  IndexDocument,
  SearchEngine,
  SearchRequest,
  SearchResponse,
} from "../search/index.js";
import { createToolRegistry } from "../tool-registry.js";
import { InMemoryConfirmationGate } from "../tools/registry.js";
import { AssistantOrchestrator } from "./orchestrator.js";
import { InMemoryAssistantStore } from "./store.js";
import { registerAssistantTools } from "./tools.js";
import type { AssistantTurnResponse } from "./types.js";

describe("AssistantOrchestrator", () => {
  it("covers the PRD assistant share flow across drive search, chat search, pending confirmation, and approved execution", async () => {
    const actor: Actor = {
      id: "00000000-0000-4000-8000-000000000001",
      orgId: "00000000-0000-4000-8000-000000000010",
      type: "user",
      displayName: "Ada",
      scopes: ["assistant.read", "assistant.write", "drive.read", "drive.write", "chat.read"],
    };
    const targetActorId = "00000000-0000-4000-8000-000000000002";
    const prdObjectId = "00000000-0000-4000-8000-0000000000aa";
    const store = new InMemoryAssistantStore();
    const drive = new FakeDriveStore(prdObjectId);
    const chat = new FakeChatStore(targetActorId);
    const search = new FakeSearchEngine([
      {
        id: `drive:${prdObjectId}`,
        type: "drive",
        title: "Q3 Launch PRD",
        body: "The Q3 Launch PRD should be shared with Bruno for review.",
      },
      {
        id: "chat:share-request",
        type: "chat",
        title: "Launch room",
        body: "Bruno asked Ada to share the Q3 Launch PRD.",
      },
    ]);
    const ai = new ShareFlowAI({ prdObjectId, targetActorId });
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    const confirmationGate = new InMemoryConfirmationGate();
    registerDriveTools(tools, { store: drive });
    registerChatTools(tools, { store: chat });

    const assistant = new AssistantOrchestrator({
      store,
      ai,
      tools,
      search,
      confirmationGate,
    });
    registerAssistantTools(tools, { store, orchestrator: assistant });

    const turn = await assistant.sendMessage({
      actor,
      content:
        "Share the Q3 Launch PRD with Bruno as commenter after checking drive and chat context.",
      request: { requestId: "req-share-1", traceId: "trace-share-1" },
    });

    expect(turn.sources.map((source) => source.id)).toEqual([
      `drive:${prdObjectId}`,
      "chat:share-request",
    ]);
    expect(turn.toolCalls.map((call) => [call.toolId, call.status])).toEqual([
      ["drive.search", "executed"],
      ["chat.search", "executed"],
      ["drive.share", "pending_confirmation"],
    ]);
    expect(drive.searches).toEqual([{ query: "Q3 Launch PRD", actorId: actor.id }]);
    expect(chat.searches).toEqual([{ query: "Bruno Q3 Launch PRD", actorId: actor.id }]);
    expect(drive.shares).toEqual([]);
    expect(turn.pendingConfirmations).toHaveLength(1);
    expect(turn.pendingConfirmations[0]).toMatchObject({
      toolId: "drive.share",
      actorId: actor.id,
      input: {
        objectId: prdObjectId,
        actorIds: [targetActorId],
        role: "commenter",
      },
      status: "pending_confirmation",
    });
    expect(turn.messages.at(-1)?.role).toBe("tool");
    expect(turn.messages.at(-1)?.content).toContain("pending_confirmation");

    const resumeResult = await tools.invoke<AssistantTurnResponse>(
      "assistant.confirmation.approve",
      {
        conversationId: turn.conversation.id,
        pendingId: turn.pendingConfirmations[0]?.id ?? "",
      },
      {
        actor,
        request: { requestId: "req-share-approve", traceId: "trace-share-approve" },
      },
    );
    expect(resumeResult.ok).toBe(true);
    if (!resumeResult.ok) {
      throw new Error(resumeResult.error);
    }
    const resumed = resumeResult.output;

    expect(resumed.toolCalls).toEqual([
      {
        toolCallId: turn.pendingConfirmations[0]?.id,
        toolId: "drive.share",
        input: {
          objectId: prdObjectId,
          actorIds: [targetActorId],
          role: "commenter",
        },
        status: "executed",
        output: {
          objectId: prdObjectId,
          sharedWithActorIds: [targetActorId],
          role: "commenter",
        },
      },
    ]);
    expect(resumed.response).toMatchObject({
      role: "assistant",
      content: "Shared the Q3 Launch PRD with Bruno as commenter.",
    });
    expect(resumed.messages.at(-2)).toMatchObject({
      role: "tool",
      toolCallId: turn.pendingConfirmations[0]?.id,
      metadata: {
        toolCall: {
          status: "executed",
          output: {
            objectId: prdObjectId,
            sharedWithActorIds: [targetActorId],
            role: "commenter",
          },
        },
      },
    });
    expect(drive.shares).toEqual([
      {
        objectId: prdObjectId,
        actorId: actor.id,
        targetActorIds: [targetActorId],
        role: "commenter",
      },
    ]);
  });

  it("cancels a pending confirmation through the assistant tool without executing the action", async () => {
    const actor: Actor = {
      id: "00000000-0000-4000-8000-000000000001",
      orgId: "00000000-0000-4000-8000-000000000010",
      type: "user",
      displayName: "Ada",
      scopes: ["assistant.read", "assistant.write", "demo.delete"],
    };
    const store = new InMemoryAssistantStore();
    const ai = new CancelFlowAI();
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    const confirmationGate = new InMemoryConfirmationGate();
    let destructiveInvoked = false;

    tools.register(
      readTool({
        id: "demo.delete",
        description: "Delete demo content.",
        permission: "demo.delete",
        sideEffects: "destructive",
        handler: async () => {
          destructiveInvoked = true;
          return { deleted: true };
        },
      }),
    );

    const assistant = new AssistantOrchestrator({
      store,
      ai,
      tools,
      confirmationGate,
    });
    registerAssistantTools(tools, { store, orchestrator: assistant });

    expect(tools.get("assistant.confirmation.cancel")).toBeDefined();

    const turn = await assistant.sendMessage({
      actor,
      content: "Delete the launch note",
      request: { requestId: "req-cancel-1", traceId: "trace-cancel-1" },
    });

    expect(turn.pendingConfirmations).toHaveLength(1);
    expect(turn.toolCalls[0]).toMatchObject({
      toolId: "demo.delete",
      status: "pending_confirmation",
    });

    const pendingId = turn.pendingConfirmations[0]?.id ?? "";
    const cancelResult = await tools.invoke<AssistantTurnResponse>(
      "assistant.confirmation.cancel",
      {
        conversationId: turn.conversation.id,
        pendingId,
      },
      {
        actor,
        request: { requestId: "req-cancel-2", traceId: "trace-cancel-2" },
      },
    );
    expect(cancelResult.ok).toBe(true);
    if (!cancelResult.ok) {
      throw new Error(cancelResult.error);
    }

    const cancelled = cancelResult.output;
    expect(destructiveInvoked).toBe(false);
    await expect(confirmationGate.get({ id: pendingId, actor })).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(cancelled.toolCalls).toEqual([
      {
        toolCallId: pendingId,
        toolId: "demo.delete",
        input: { id: "launch-note" },
        status: "skipped",
        error: "Pending assistant tool action was cancelled by the actor.",
      },
    ]);
    expect(cancelled.response).toMatchObject({
      role: "assistant",
      content: "Cancelled the delete request. I did not delete the launch note.",
    });
    expect(cancelled.messages.at(-2)).toMatchObject({
      role: "tool",
      toolCallId: pendingId,
      metadata: {
        cancelledPendingTool: {
          id: pendingId,
          toolId: "demo.delete",
          status: "cancelled",
        },
        toolCall: {
          status: "skipped",
          error: "Pending assistant tool action was cancelled by the actor.",
        },
      },
    });
  });

  it("applies AI cost limits to assistant turns before calling a provider", async () => {
    const actor: Actor = {
      id: "00000000-0000-4000-8000-000000000001",
      orgId: "00000000-0000-4000-8000-000000000010",
      type: "user",
      displayName: "Ada",
      scopes: ["assistant.write"],
    };
    const limiter = new InMemoryAICostLimiter();
    const provider = new MeteredAssistantProvider();
    const ai = new AIRouter({
      providers: [provider],
      costGuard: createAICostGuard({
        limiter,
        tier: "business",
        budget: { actorDailyUsdMicros: aiCentsToUsdMicros(2) },
        now: () => new Date("2026-05-20T12:00:00.000Z"),
      }),
    });
    const assistant = new AssistantOrchestrator({
      store: new InMemoryAssistantStore(),
      ai,
      tools: createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() }),
    });

    await expect(
      assistant.sendMessage({
        actor,
        content: "Summarize the launch note",
        request: { requestId: "req-cost-1", traceId: "trace-cost-1" },
      }),
    ).resolves.toMatchObject({
      response: { content: "Metered assistant response 1." },
    });
    expect(provider.chatCalls).toBe(1);
    expect(limiter.listRecords({ orgId: actor.orgId, actorId: actor.id })).toHaveLength(1);

    await expect(
      assistant.sendMessage({
        actor,
        content: "Summarize it again",
        request: { requestId: "req-cost-2", traceId: "trace-cost-2" },
      }),
    ).rejects.toBeInstanceOf(AICostLimitExceededError);
    expect(provider.chatCalls).toBe(1);
    expect(limiter.listRecords({ orgId: actor.orgId, actorId: actor.id })).toHaveLength(1);
  });

  it("persists a multi-turn assistant flow with search, tool use, pending confirmation, and memory forget", async () => {
    const actor: Actor = {
      id: "00000000-0000-4000-8000-000000000001",
      orgId: "00000000-0000-4000-8000-000000000010",
      type: "user",
      displayName: "Ada",
      scopes: ["assistant.read", "assistant.write", "demo.read", "demo.delete"],
    };
    const store = new InMemoryAssistantStore();
    const memory = new FakeMemoryStore();
    const search = new FakeSearchEngine([
      {
        id: "docs:launch",
        type: "docs",
        title: "Launch Plan",
        body: "Launch owner is Ada and the ship date is Friday.",
      },
    ]);
    const ai = new FakeAssistantAI();
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    const confirmationGate = new InMemoryConfirmationGate();
    let destructiveInvoked = false;

    tools.register(
      readTool({
        id: "demo.lookup",
        description: "Look up demo content.",
        permission: "demo.read",
        handler: async (input) => ({
          found: true,
          ...(input.query === undefined ? {} : { query: input.query }),
        }),
      }),
    );
    tools.register(
      readTool({
        id: "demo.delete",
        description: "Delete demo content.",
        permission: "demo.delete",
        sideEffects: "destructive",
        handler: async () => {
          destructiveInvoked = true;
          return { deleted: true };
        },
      }),
    );

    const assistant = new AssistantOrchestrator({
      store,
      ai,
      tools,
      search,
      memory,
      confirmationGate,
    });

    const firstTurn = await assistant.sendMessage({
      actor,
      content: "Find the launch owner",
      memoryOptIn: true,
      request: { requestId: "req-1", traceId: "trace-1" },
    });

    expect(firstTurn.response.content).toContain("Ada owns launch");
    expect(firstTurn.sources.map((source) => source.id)).toEqual(["docs:launch"]);
    expect(firstTurn.toolCalls).toHaveLength(1);
    expect(firstTurn.toolCalls[0]).toMatchObject({
      toolId: "demo.lookup",
      status: "executed",
    });
    expect(firstTurn.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(memory.items).toHaveLength(1);

    const secondTurn = await assistant.sendMessage({
      actor,
      conversationId: firstTurn.conversation.id,
      content: "Delete the launch note",
      request: { requestId: "req-2", traceId: "trace-2" },
    });

    expect(secondTurn.memory.map((item) => item.id)).toEqual([memory.items[0]?.id]);
    expect(secondTurn.pendingConfirmations).toHaveLength(1);
    expect(secondTurn.toolCalls[0]).toMatchObject({
      toolId: "demo.delete",
      status: "pending_confirmation",
    });
    expect(destructiveInvoked).toBe(false);
    await expect(
      confirmationGate.get({ id: secondTurn.pendingConfirmations[0]?.id ?? "", actor }),
    ).resolves.toMatchObject({ status: "pending_confirmation" });

    const forget = await assistant.forgetMemory({
      actor,
      conversationId: firstTurn.conversation.id,
      criteria: { all: true },
      disableMemory: true,
    });

    expect(forget.forgottenCount).toBe(2);
    expect(forget.preference?.enabled).toBe(false);
    expect(forget.conversation?.memoryOptIn).toBe(false);
    expect(memory.items).toHaveLength(0);
  });

  it("routes phase 8 slash commands through deterministic instructions, search, metadata, and bounded tools", async () => {
    const actor: Actor = {
      id: "00000000-0000-4000-8000-000000000001",
      orgId: "00000000-0000-4000-8000-000000000010",
      type: "user",
      displayName: "Ada",
      scopes: [
        "assistant.write",
        "calendar.read",
        "calendar.read:freebusy",
        "calendar.write",
        "chat.read",
        "docs.read",
        "drive.read",
        "mail.read",
      ],
    };
    const cases = [
      {
        content: "/draft mail to Bruno about launch",
        query: "mail to Bruno about launch",
        instruction: "Draft content",
        tools: [
          "chat.search",
          "docs.export",
          "docs.get",
          "drive.list",
          "drive.search",
          "mail.search",
          "mail.thread.get",
        ],
      },
      {
        content: "/summarize this thread",
        query: "this thread",
        instruction: "Summarize",
        tools: [
          "calendar.event.list",
          "chat.search",
          "docs.export",
          "docs.get",
          "drive.list",
          "drive.search",
          "mail.search",
          "mail.thread.get",
        ],
      },
      {
        content: "/find files about launch",
        query: "files about launch",
        instruction: "Find actor-visible",
        tools: [
          "calendar.event.list",
          "chat.search",
          "docs.export",
          "docs.get",
          "drive.list",
          "drive.search",
          "mail.search",
        ],
      },
      {
        content: "/schedule meeting with Ada next week",
        query: "meeting with Ada next week",
        instruction: "Help schedule",
        tools: ["calendar.event.create", "calendar.event.list", "calendar.find-time"],
      },
    ] as const;

    for (const testCase of cases) {
      const store = new InMemoryAssistantStore();
      const search = new FakeSearchEngine([
        {
          id: "docs:slash",
          type: "docs",
          title: "Slash command context",
          body: "Actor-visible context for slash command routing.",
        },
      ]);
      const ai = new SlashRouteAI(testCase);
      const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
      for (const tool of routeTestTools) {
        tools.register(tool);
      }
      const assistant = new AssistantOrchestrator({
        store,
        ai,
        tools,
        search,
      });

      const turn = await assistant.sendMessage({
        actor,
        content: testCase.content,
        request: { requestId: `req-${testCase.query}`, traceId: `trace-${testCase.query}` },
      });

      expect(turn.response.content).toBe(`Routed ${testCase.content}`);
      expect(search.searches.map((request) => request.query)).toEqual([testCase.query]);
      expect(turn.messages[0]?.metadata).toMatchObject({
        slashCommand: {
          name: testCase.content.slice(1, testCase.content.indexOf(" ")),
          args: testCase.query,
        },
      });
    }
  });
});

class ShareFlowAI implements AICapability {
  readonly calls: ChatRequest[] = [];

  constructor(
    private readonly options: { readonly prdObjectId: string; readonly targetActorId: string },
  ) {}

  async chat(request: ChatRequest, _ctx?: Partial<AICallContext>): Promise<ChatResponse> {
    void _ctx;
    this.calls.push(request);
    if (this.calls.length === 1) {
      expect(request.feature).toBe("assistant.chat");
      expect(request.tools).toEqual(
        expect.arrayContaining(["drive.search", "chat.search", "drive.share"]),
      );
      expect(JSON.stringify(request.messages)).toContain("Q3 Launch PRD");
      return {
        providerId: "fake",
        model: "fake-model",
        message: "I will verify the PRD and chat context first.",
        toolCalls: [
          { id: "drive.search", input: { query: "Q3 Launch PRD" } },
          { id: "chat.search", input: { query: "Bruno Q3 Launch PRD" } },
        ],
      };
    }
    expect(JSON.stringify(request.messages)).toContain("Q3 Launch PRD");
    expect(JSON.stringify(request.messages)).toContain("Bruno asked Ada");
    if (this.calls.length === 3) {
      expect(JSON.stringify(request.messages)).toContain('\\"sharedWithActorIds\\"');
      return {
        providerId: "fake",
        model: "fake-model",
        message: "Shared the Q3 Launch PRD with Bruno as commenter.",
      };
    }
    return {
      providerId: "fake",
      model: "fake-model",
      message: "I found the PRD and Bruno's request. I need confirmation to share it.",
      toolCalls: [
        {
          id: "drive.share",
          input: {
            objectId: this.options.prdObjectId,
            actorIds: [this.options.targetActorId],
            role: "commenter",
          },
        },
      ],
    };
  }
}

class FakeAssistantAI implements AICapability {
  readonly calls: ChatRequest[] = [];

  async chat(request: ChatRequest, _ctx?: Partial<AICallContext>): Promise<ChatResponse> {
    void _ctx;
    this.calls.push(request);
    if (this.calls.length === 1) {
      expect(request.feature).toBe("assistant.chat");
      expect(request.tools).toContain("demo.lookup");
      expect(JSON.stringify(request.messages)).toContain("Launch Plan");
      return {
        providerId: "fake",
        model: "fake-model",
        message: "I will look that up.",
        toolCalls: [{ id: "demo.lookup", input: { query: "launch owner" } }],
      };
    }
    if (this.calls.length === 2) {
      expect(JSON.stringify(request.messages)).toContain('\\"found\\":true');
      return {
        providerId: "fake",
        model: "fake-model",
        message: "Ada owns launch based on the launch plan.",
      };
    }
    return {
      providerId: "fake",
      model: "fake-model",
      message: "I need confirmation before deleting that note.",
      toolCalls: [{ id: "demo.delete", input: { id: "launch-note" } }],
    };
  }
}

class CancelFlowAI implements AICapability {
  readonly calls: ChatRequest[] = [];

  async chat(request: ChatRequest, _ctx?: Partial<AICallContext>): Promise<ChatResponse> {
    void _ctx;
    this.calls.push(request);
    if (this.calls.length === 1) {
      expect(request.feature).toBe("assistant.chat");
      expect(request.tools).toEqual(
        expect.arrayContaining(["demo.delete", "assistant.confirmation.cancel"]),
      );
      return {
        providerId: "fake",
        model: "fake-model",
        message: "I need confirmation before deleting that note.",
        toolCalls: [{ id: "demo.delete", input: { id: "launch-note" } }],
      };
    }
    expect(JSON.stringify(request.messages)).toContain("cancelled");
    expect(JSON.stringify(request.metadata)).toContain("cancelledToolId");
    return {
      providerId: "fake",
      model: "fake-model",
      message: "Cancelled the delete request. I did not delete the launch note.",
    };
  }
}

class SlashRouteAI implements AICapability {
  readonly calls: ChatRequest[] = [];

  constructor(
    private readonly expected: {
      readonly content: string;
      readonly query: string;
      readonly instruction: string;
      readonly tools: readonly string[];
    },
  ) {}

  async chat(request: ChatRequest, _ctx?: Partial<AICallContext>): Promise<ChatResponse> {
    void _ctx;
    this.calls.push(request);
    expect(request.feature).toBe("assistant.chat");
    expect(request.tools).toEqual(this.expected.tools);
    expect(request.tools).not.toContain("mail.send");
    expect(request.tools).not.toContain("demo.delete");
    expect(JSON.stringify(request.messages)).toContain(this.expected.instruction);
    expect(JSON.stringify(request.messages)).toContain(this.expected.query);
    expect(request.metadata?.slashCommand).toMatchObject({
      args: this.expected.query,
    });
    expect(request.metadata?.slashMetadata).toMatchObject({
      searchQuery: this.expected.query,
    });
    expect(jsonStringArray(request.metadata?.slashMetadata, "toolIds")).toEqual(
      expect.arrayContaining([...this.expected.tools]),
    );
    expect(jsonStringArray(request.metadata, "slashToolIds")).toEqual(
      expect.arrayContaining([...this.expected.tools]),
    );
    return {
      providerId: "fake",
      model: "fake-model",
      message: `Routed ${this.expected.content}`,
    };
  }
}

class MeteredAssistantProvider implements LLMProviderCapability {
  readonly id = "metered";
  readonly protocol = "openai-compatible";
  readonly tags: readonly string[] = [];
  chatCalls = 0;

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.chatCalls += 1;
    expect(request.feature).toBe("assistant.chat");
    return {
      providerId: this.id,
      model: request.model ?? "metered-model",
      message: `Metered assistant response ${String(this.chatCalls)}.`,
      usage: { costCents: 2 },
    };
  }

  async models() {
    return [{ id: "metered-model", inputCostPer1kTokensCents: 1000 }];
  }

  async countTokens() {
    return 1;
  }
}

class FakeSearchEngine implements SearchEngine {
  readonly id = "fake-search";
  readonly searches: SearchRequest[] = [];

  constructor(private readonly hits: readonly IndexDocument[]) {}

  async index(): Promise<void> {}

  async upsert(): Promise<void> {}

  async delete(): Promise<void> {}

  async search(request: SearchRequest): Promise<SearchResponse> {
    this.searches.push(request);
    return {
      query: request.query,
      hits: this.hits.map((hit, index) => ({ ...hit, score: 1 - index / 10 })),
    };
  }
}

const routeTestTools: readonly ToolDefinition[] = [
  readTool({
    id: "calendar.event.create",
    description: "Create a calendar event.",
    permission: "calendar.write",
    sideEffects: "write",
    handler: async () => ({ created: true }),
  }),
  readTool({
    id: "calendar.event.list",
    description: "List calendar events.",
    permission: "calendar.read",
    handler: async () => ({ events: [] }),
  }),
  readTool({
    id: "calendar.find-time",
    description: "Find meeting times.",
    permission: "calendar.read:freebusy",
    handler: async () => ({ slots: [] }),
  }),
  readTool({
    id: "chat.search",
    description: "Search chat.",
    permission: "chat.read",
    handler: async () => ({ hits: [] }),
  }),
  readTool({
    id: "demo.delete",
    description: "Unrelated destructive tool.",
    permission: "demo.delete",
    sideEffects: "destructive",
    handler: async () => ({ deleted: true }),
  }),
  readTool({
    id: "docs.export",
    description: "Export a doc.",
    permission: "docs.read",
    handler: async () => ({ markdown: "" }),
  }),
  readTool({
    id: "docs.get",
    description: "Get a doc.",
    permission: "docs.read",
    handler: async () => ({ doc: null }),
  }),
  readTool({
    id: "drive.list",
    description: "List drive files.",
    permission: "drive.read",
    handler: async () => ({ files: [] }),
  }),
  readTool({
    id: "drive.search",
    description: "Search drive.",
    permission: "drive.read",
    handler: async () => ({ hits: [] }),
  }),
  readTool({
    id: "mail.search",
    description: "Search mail.",
    permission: "mail.read",
    handler: async () => ({ hits: [] }),
  }),
  readTool({
    id: "mail.send",
    description: "Send mail.",
    permission: "mail.send",
    sideEffects: "external_communication",
    handler: async () => ({ sent: true }),
  }),
  readTool({
    id: "mail.thread.get",
    description: "Get a mail thread.",
    permission: "mail.read",
    handler: async () => ({ thread: null }),
  }),
];

class FakeMemoryStore implements MemoryStore {
  readonly id = "fake-memory";
  readonly items: MemoryItem[] = [];
  #next = 1;

  async recall(actor: Actor, _query: string, k: number): Promise<readonly MemoryItem[]> {
    return this.items
      .filter((item) => item.actorId === actor.id && item.orgId === actor.orgId)
      .slice(0, k);
  }

  async store(actor: Actor, item: MemoryInput): Promise<MemoryItem> {
    const memory: MemoryItem = {
      id: `mem-${String(this.#next)}`,
      actorId: actor.id,
      orgId: actor.orgId,
      source: item.source ?? "assistant.conversation",
      content: item.content,
      createdAt: new Date("2026-05-20T12:00:00.000Z").toISOString(),
      ...(item.metadata === undefined ? {} : { metadata: item.metadata }),
    };
    this.#next += 1;
    this.items.push(memory);
    return memory;
  }

  async forget(actor: Actor, criteria: ForgetCriteria): Promise<number> {
    const before = this.items.length;
    if (criteria.all === true) {
      for (let index = this.items.length - 1; index >= 0; index -= 1) {
        const item = this.items[index];
        if (item?.actorId === actor.id && item.orgId === actor.orgId) {
          this.items.splice(index, 1);
        }
      }
      return before - this.items.length;
    }
    const ids = new Set(criteria.ids ?? []);
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const item = this.items[index];
      if (
        item !== undefined &&
        ids.has(item.id) &&
        item.actorId === actor.id &&
        item.orgId === actor.orgId
      ) {
        this.items.splice(index, 1);
      }
    }
    return before - this.items.length;
  }
}

class FakeDriveStore implements DriveStore {
  readonly searches: Array<{ readonly query: string | undefined; readonly actorId: string }> = [];
  readonly shares: Array<{
    readonly objectId: string;
    readonly actorId: string;
    readonly targetActorIds: readonly string[];
    readonly role: string;
  }> = [];

  constructor(private readonly prdObjectId: string) {}

  async prepareUpload(): Promise<DriveUploadRecord> {
    throw new Error("prepareUpload is not used by this test.");
  }

  async finalizeUpload(): Promise<DriveVersionRecord> {
    throw new Error("finalizeUpload is not used by this test.");
  }

  async list(): Promise<readonly DriveEntryRecord[]> {
    return [];
  }

  async share(input: Parameters<DriveStore["share"]>[0]) {
    this.shares.push({
      objectId: input.objectId,
      actorId: input.actorId,
      targetActorIds: input.targetActorIds,
      role: input.role,
    });
    return {
      objectId: input.objectId,
      sharedWithActorIds: input.targetActorIds,
      role: input.role,
    };
  }

  async move(): Promise<DriveEntryRecord | null> {
    return null;
  }

  async trash(): Promise<DriveEntryRecord | null> {
    return null;
  }

  async restore(): Promise<DriveEntryRecord | null> {
    return null;
  }

  async delete(): Promise<boolean> {
    return false;
  }

  async search(input: Parameters<DriveStore["search"]>[0]): Promise<readonly DriveSearchHit[]> {
    this.searches.push({ query: input.query, actorId: input.actorId });
    return [
      {
        objectId: this.prdObjectId,
        name: "Q3 Launch PRD",
        ownerActorId: input.actorId,
        app: null,
        mimeType: "application/vnd.helix.prd",
        byteSize: 42_000,
        sha256: "abc123",
        folderId: null,
        preview: "Q3 Launch PRD share plan for Bruno.",
        metadata: {},
        updatedAt: new Date("2026-05-20T14:00:00.000Z"),
      },
    ];
  }

  async createFolder(): Promise<DriveEntryRecord> {
    throw new Error("createFolder is not used by this test.");
  }
}

class FakeChatStore implements ChatStore {
  readonly searches: Array<{ readonly query: string | undefined; readonly actorId: string }> = [];

  constructor(private readonly targetActorId: string) {}

  async createRoom(): Promise<ChatRoomRecord> {
    throw new Error("createRoom is not used by this test.");
  }

  async invite(): Promise<{
    readonly roomId: string;
    readonly invitedActorIds: readonly string[];
  }> {
    throw new Error("invite is not used by this test.");
  }

  async listRooms(): Promise<readonly ChatRoomRecord[]> {
    return [];
  }

  async sendMessage(): Promise<ChatMessageRecord> {
    throw new Error("sendMessage is not used by this test.");
  }

  async react(): Promise<ChatReactionRecord | null> {
    return null;
  }

  async editMessage(): Promise<ChatMessageRecord | null> {
    return null;
  }

  async deleteMessage(): Promise<ChatMessageRecord | null> {
    return null;
  }

  async markRead(): Promise<ChatReadReceiptRecord> {
    throw new Error("markRead is not used by this test.");
  }

  async listMessages(): Promise<readonly ChatMessageRecord[]> {
    return [];
  }

  async search(input: Parameters<ChatStore["search"]>[0]): Promise<readonly ChatSearchHit[]> {
    this.searches.push({ query: input.query, actorId: input.actorId });
    return [
      {
        roomId: "00000000-0000-4000-8000-0000000000bb",
        messageId: "00000000-0000-4000-8000-0000000000cc",
        actorId: this.targetActorId,
        subject: "Launch room",
        preview: "Bruno asked Ada to share the Q3 Launch PRD.",
        sentAt: new Date("2026-05-20T13:30:00.000Z"),
      },
    ];
  }

  async getRoomForActor(): Promise<ChatRoomRecord | null> {
    return null;
  }
}

function readTool(input: {
  readonly id: string;
  readonly description: string;
  readonly permission: string;
  readonly sideEffects?: ToolDefinition["sideEffects"];
  readonly handler: (input: {
    readonly query?: string;
    readonly id?: string;
  }) => Promise<JsonObject>;
}): ToolDefinition<{ readonly query?: string; readonly id?: string }, JsonObject> {
  return {
    id: input.id,
    description: input.description,
    permission: input.permission,
    sideEffects: input.sideEffects ?? "read",
    inputSchema: schema((value) => toJsonObject(value)),
    outputSchema: schema((value) => toJsonObject(value)),
    handler: input.handler,
  };
}

function schema<T>(parse: (value: unknown) => T) {
  return {
    parse,
    toJsonSchema: () => ({ type: "object", additionalProperties: true }),
  };
}

function toJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value ?? {})) as JsonObject;
}

function jsonStringArray(source: unknown, key: string): readonly string[] {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return [];
  }
  const value = (source as Record<string, unknown>)[key];
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")
    ? value
    : [];
}
