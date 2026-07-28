import { randomUUID } from "node:crypto";
import type {
  Actor,
  AICallContext,
  AICapability,
  AIMessage,
  AIToolChoice,
  ChatChunk,
  ChatResponse,
  ChatUsage,
  JsonObject,
  JsonValue,
  PendingToolInvocation,
  RequestContext,
  ToolDefinition,
} from "@helix/sdk-types";
import { isJsonObject } from "@helix/sdk-types";
import type { MemoryItem, MemoryStore } from "../ai/memory/index.js";
import type { SearchEngine } from "../search/index.js";
import { createScopedSearchRequest } from "../search/scope.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import type { ConfirmationGate } from "../tools/registry.js";
import {
  actorToolInvocationPrincipal,
  toolInvocationOptions,
  type ToolInvocationPrincipal,
} from "../auth/tool-invocation-principal.js";
import {
  parseAssistantSlashCommand,
  resolveDefaultAssistantSlashCommand,
  type AssistantSlashCommandHooks,
} from "./slash.js";
import type {
  AssistantConversation,
  AssistantApprovePendingToolInput,
  AssistantCancelPendingToolInput,
  AssistantForgetMemoryInput,
  AssistantForgetMemoryResult,
  AssistantSendMessageInput,
  AssistantSource,
  AssistantStore,
  AssistantStreamEvent,
  AssistantToolCallResult,
  AssistantTurnResponse,
  AssistantVisibleTool,
} from "./types.js";
import { searchHitToAssistantSource } from "./types.js";

export interface AssistantOrchestratorOptions {
  readonly store: AssistantStore;
  readonly ai: AICapability;
  readonly tools: RuntimeToolRegistry;
  readonly search?: SearchEngine;
  readonly memory?: MemoryStore;
  readonly confirmationGate?: ConfirmationGate;
  readonly slashCommands?: AssistantSlashCommandHooks;
  readonly maxToolRounds?: number;
  readonly historyLimit?: number;
  readonly searchLimit?: number;
  readonly memoryLimit?: number;
}

export class AssistantOrchestrator {
  readonly #maxToolRounds: number;
  readonly #historyLimit: number;
  readonly #searchLimit: number;
  readonly #memoryLimit: number;

  constructor(private readonly options: AssistantOrchestratorOptions) {
    this.#maxToolRounds = options.maxToolRounds ?? 3;
    this.#historyLimit = options.historyLimit ?? 24;
    this.#searchLimit = options.searchLimit ?? 5;
    this.#memoryLimit = options.memoryLimit ?? 5;
  }

  async sendMessage(input: AssistantSendMessageInput): Promise<AssistantTurnResponse> {
    let conversation = await this.getOrCreateConversation(input);
    if (input.memoryOptIn !== undefined) {
      await this.options.store.setMemoryPreference({
        actor: input.actor,
        enabled: input.memoryOptIn,
        metadata: { source: "assistant.conversation" },
      });
      const updated = await this.options.store.setConversationMemoryOptIn({
        orgId: input.actor.orgId,
        actorId: input.actor.id,
        conversationId: conversation.id,
        enabled: input.memoryOptIn,
      });
      conversation = updated ?? conversation;
    }

    const slashCommand = parseAssistantSlashCommand(input.content);
    const slashHook =
      slashCommand === null
        ? undefined
        : this.options.slashCommands === undefined
          ? resolveDefaultAssistantSlashCommand(slashCommand)
          : await this.options.slashCommands.resolve({
              actor: input.actor,
              command: slashCommand,
              ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            });
    const userMessage = await this.options.store.appendMessage({
      orgId: input.actor.orgId,
      conversationId: conversation.id,
      actorId: input.actor.id,
      role: "user",
      content: input.content,
      metadata: toJsonObject({
        ...(input.metadata ?? {}),
        ...(slashCommand === null ? {} : { slashCommand }),
      }),
    });
    const searchQuery =
      slashHook?.searchQuery !== undefined
        ? slashHook.searchQuery
        : slashCommand === null
          ? input.content
          : slashCommand.args.trim();
    const [sources, recalledMemory, allVisibleTools, history] = await Promise.all([
      this.collectSearchContext(input.actor, searchQuery),
      this.collectMemoryContext(input.actor, conversation, searchQuery),
      this.listVisibleTools(input.actor, input.principal),
      this.options.store.listMessages({
        orgId: input.actor.orgId,
        conversationId: conversation.id,
        limit: this.#historyLimit,
      }),
    ]);
    const visibleTools = routeVisibleTools(allVisibleTools, slashHook?.toolIds);

    const toolCalls: AssistantToolCallResult[] = [];
    const pendingConfirmations: PendingToolInvocation[] = [];
    const baseSystemMessage = systemMessage({
      sources,
      memory: recalledMemory,
      tools: visibleTools,
      ...(slashHook?.instruction === undefined ? {} : { slashInstruction: slashHook.instruction }),
    });
    const promptMessages: AIMessage[] = [baseSystemMessage, ...history.map(toAIMessage)];
    let aiResponse: ChatResponse | undefined;
    let responseMessage = userMessage;
    let round = 0;

    while (round < this.#maxToolRounds) {
      aiResponse = await this.options.ai.chat(
        {
          feature: "assistant.chat",
          messages: promptMessages,
          tools: visibleTools.map((tool) => tool.id),
          classification: input.classification ?? "standard",
          metadata: toJsonObject({
            visibleTools,
            sourceIds: sources.map((source) => source.id),
            memoryIds: recalledMemory.map((memory) => memory.id),
            ...(slashCommand === null ? {} : { slashCommand }),
            ...(slashHook?.metadata === undefined ? {} : { slashMetadata: slashHook.metadata }),
            ...(slashHook?.toolIds === undefined ? {} : { slashToolIds: [...slashHook.toolIds] }),
          }),
        },
        aiCallContext(input.actor, input.request),
      );
      responseMessage = await this.options.store.appendMessage({
        orgId: input.actor.orgId,
        conversationId: conversation.id,
        role: "assistant",
        content: aiResponse.message,
        metadata: toJsonObject({
          providerId: aiResponse.providerId,
          model: aiResponse.model,
          usage: aiResponse.usage ?? {},
          ...(aiResponse.metadata === undefined ? {} : { ai: aiResponse.metadata }),
          toolCalls: aiResponse.toolCalls ?? [],
        }),
      });
      promptMessages.push(toAIMessage(responseMessage));

      if (aiResponse.toolCalls === undefined || aiResponse.toolCalls.length === 0) {
        break;
      }

      const roundResults = await Promise.all(
        aiResponse.toolCalls.map((toolCall) =>
          this.invokeToolCall({
            actor: input.actor,
            principal: principalForAssistantInput(input),
            visibleTools,
            toolCallId: randomUUID(),
            toolId: toolCall.id,
            input: toolCall.input ?? {},
            ...(input.request === undefined ? {} : { request: input.request }),
          }),
        ),
      );
      for (const result of roundResults) {
        toolCalls.push(result);
        if (result.pending !== undefined) {
          pendingConfirmations.push(result.pending);
        }
        const toolMessage = await this.options.store.appendMessage({
          orgId: input.actor.orgId,
          conversationId: conversation.id,
          role: "tool",
          content: toolResultContent(result),
          toolCallId: result.toolCallId,
          metadata: toJsonObject({ toolCall: result }),
        });
        promptMessages.push(toAIMessage(toolMessage));
      }

      if (roundResults.some((result) => result.status === "pending_confirmation")) {
        break;
      }
      round += 1;
    }

    if (aiResponse === undefined) {
      throw new Error("Assistant did not produce a response.");
    }
    await this.rememberTurn(input.actor, conversation, input.content, responseMessage.content);

    return {
      conversation,
      messages: await this.options.store.listMessages({
        orgId: input.actor.orgId,
        conversationId: conversation.id,
        limit: this.#historyLimit,
      }),
      response: responseMessage,
      ai: aiResponse,
      toolCalls,
      sources,
      memory: recalledMemory,
      pendingConfirmations,
    };
  }

  /**
   * Streaming variant of {@link sendMessage}. Yields incremental `delta`
   * events as the model produces text, then a terminal `final` event carrying
   * the complete {@link AssistantTurnResponse}. Tool invocation, confirmation
   * gating, memory, and persistence behave exactly as in {@link sendMessage}.
   */
  async *sendMessageStream(input: AssistantSendMessageInput): AsyncGenerator<AssistantStreamEvent> {
    let conversation = await this.getOrCreateConversation(input);
    if (input.memoryOptIn !== undefined) {
      await this.options.store.setMemoryPreference({
        actor: input.actor,
        enabled: input.memoryOptIn,
        metadata: { source: "assistant.conversation" },
      });
      const updated = await this.options.store.setConversationMemoryOptIn({
        orgId: input.actor.orgId,
        actorId: input.actor.id,
        conversationId: conversation.id,
        enabled: input.memoryOptIn,
      });
      conversation = updated ?? conversation;
    }

    const slashCommand = parseAssistantSlashCommand(input.content);
    const slashHook =
      slashCommand === null
        ? undefined
        : this.options.slashCommands === undefined
          ? resolveDefaultAssistantSlashCommand(slashCommand)
          : await this.options.slashCommands.resolve({
              actor: input.actor,
              command: slashCommand,
              ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            });
    const userMessage = await this.options.store.appendMessage({
      orgId: input.actor.orgId,
      conversationId: conversation.id,
      actorId: input.actor.id,
      role: "user",
      content: input.content,
      metadata: toJsonObject({
        ...(input.metadata ?? {}),
        ...(slashCommand === null ? {} : { slashCommand }),
      }),
    });
    const searchQuery =
      slashHook?.searchQuery !== undefined
        ? slashHook.searchQuery
        : slashCommand === null
          ? input.content
          : slashCommand.args.trim();
    const [sources, recalledMemory, allVisibleTools, history] = await Promise.all([
      this.collectSearchContext(input.actor, searchQuery),
      this.collectMemoryContext(input.actor, conversation, searchQuery),
      this.listVisibleTools(input.actor, input.principal),
      this.options.store.listMessages({
        orgId: input.actor.orgId,
        conversationId: conversation.id,
        limit: this.#historyLimit,
      }),
    ]);
    const visibleTools = routeVisibleTools(allVisibleTools, slashHook?.toolIds);

    const toolCalls: AssistantToolCallResult[] = [];
    const pendingConfirmations: PendingToolInvocation[] = [];
    const baseSystemMessage = systemMessage({
      sources,
      memory: recalledMemory,
      tools: visibleTools,
      ...(slashHook?.instruction === undefined ? {} : { slashInstruction: slashHook.instruction }),
    });
    const promptMessages: AIMessage[] = [baseSystemMessage, ...history.map(toAIMessage)];
    let aiResponse: ChatResponse | undefined;
    let responseMessage = userMessage;
    let round = 0;

    while (round < this.#maxToolRounds) {
      const chatRequest = {
        feature: "assistant.chat",
        messages: promptMessages,
        tools: visibleTools.map((tool) => tool.id),
        classification: input.classification ?? "standard",
        metadata: toJsonObject({
          visibleTools,
          sourceIds: sources.map((source) => source.id),
          memoryIds: recalledMemory.map((memory) => memory.id),
          ...(slashCommand === null ? {} : { slashCommand }),
          ...(slashHook?.metadata === undefined ? {} : { slashMetadata: slashHook.metadata }),
          ...(slashHook?.toolIds === undefined ? {} : { slashToolIds: [...slashHook.toolIds] }),
        }),
      };
      const callContext = aiCallContext(input.actor, input.request);
      const currentRound = round;
      aiResponse = yield* this.#streamChatTurn(chatRequest, callContext, currentRound);
      responseMessage = await this.options.store.appendMessage({
        orgId: input.actor.orgId,
        conversationId: conversation.id,
        role: "assistant",
        content: aiResponse.message,
        metadata: toJsonObject({
          providerId: aiResponse.providerId,
          model: aiResponse.model,
          usage: aiResponse.usage ?? {},
          streamed: true,
          ...(aiResponse.metadata === undefined ? {} : { ai: aiResponse.metadata }),
          toolCalls: aiResponse.toolCalls ?? [],
        }),
      });
      promptMessages.push(toAIMessage(responseMessage));

      if (aiResponse.toolCalls === undefined || aiResponse.toolCalls.length === 0) {
        break;
      }

      const roundResults = await Promise.all(
        aiResponse.toolCalls.map((toolCall) =>
          this.invokeToolCall({
            actor: input.actor,
            principal: principalForAssistantInput(input),
            visibleTools,
            toolCallId: randomUUID(),
            toolId: toolCall.id,
            input: toolCall.input ?? {},
            ...(input.request === undefined ? {} : { request: input.request }),
          }),
        ),
      );
      for (const result of roundResults) {
        toolCalls.push(result);
        if (result.pending !== undefined) {
          pendingConfirmations.push(result.pending);
        }
        const toolMessage = await this.options.store.appendMessage({
          orgId: input.actor.orgId,
          conversationId: conversation.id,
          role: "tool",
          content: toolResultContent(result),
          toolCallId: result.toolCallId,
          metadata: toJsonObject({ toolCall: result }),
        });
        promptMessages.push(toAIMessage(toolMessage));
      }

      if (roundResults.some((result) => result.status === "pending_confirmation")) {
        break;
      }
      round += 1;
    }

    if (aiResponse === undefined) {
      throw new Error("Assistant did not produce a response.");
    }
    await this.rememberTurn(input.actor, conversation, input.content, responseMessage.content);

    yield {
      type: "final",
      turn: {
        conversation,
        messages: await this.options.store.listMessages({
          orgId: input.actor.orgId,
          conversationId: conversation.id,
          limit: this.#historyLimit,
        }),
        response: responseMessage,
        ai: aiResponse,
        toolCalls,
        sources,
        memory: recalledMemory,
        pendingConfirmations,
      },
    };
  }

  /**
   * Runs a single AI turn, streaming text deltas when the configured AI
   * capability supports `chatStream`, and falling back to a non-streaming
   * `chat` call otherwise. Returns the assembled {@link ChatResponse}.
   */
  async *#streamChatTurn(
    request: Parameters<AICapability["chat"]>[0],
    context: Partial<AICallContext>,
    round: number,
  ): AsyncGenerator<AssistantStreamEvent, ChatResponse> {
    const ai = this.options.ai;
    if (ai.chatStream === undefined) {
      const response = await ai.chat(request, context);
      if (response.message.length > 0) {
        yield { type: "delta", text: response.message, round };
      }
      return response;
    }

    let message = "";
    let usage: ChatUsage | undefined;
    let model = request.model ?? "";
    let providerId = "";
    let metadata: JsonObject | undefined;
    for await (const chunk of ai.chatStream(request, context)) {
      const typed: ChatChunk = chunk;
      if (typed.delta.length > 0) {
        message += typed.delta;
        yield { type: "delta", text: typed.delta, round };
      }
      if (typed.usage !== undefined) {
        usage = typed.usage;
      }
      if (typed.metadata !== undefined) {
        metadata = { ...(metadata ?? {}), ...typed.metadata };
        const metadataModel = typed.metadata.model;
        if (typeof metadataModel === "string" && metadataModel.length > 0) {
          model = metadataModel;
        }
        const metadataProvider = typed.metadata.providerId;
        if (typeof metadataProvider === "string" && metadataProvider.length > 0) {
          providerId = metadataProvider;
        }
      }
    }
    const toolCalls = toolCallsFromStreamMetadata(metadata);
    return {
      message,
      model,
      providerId,
      ...(usage === undefined ? {} : { usage }),
      ...(toolCalls === undefined ? {} : { toolCalls }),
      ...(metadata === undefined ? {} : { metadata }),
    };
  }

  async approvePendingTool(
    input: AssistantApprovePendingToolInput,
  ): Promise<AssistantTurnResponse> {
    if (this.options.confirmationGate === undefined) {
      throw new Error("Assistant confirmation gate is not configured.");
    }
    const conversation = await this.options.store.getConversation({
      orgId: input.actor.orgId,
      actorId: input.actor.id,
      conversationId: input.conversationId,
    });
    if (conversation === null) {
      throw new Error(`Unknown assistant conversation: ${input.conversationId}`);
    }

    const approved = await this.options.confirmationGate.approve({
      id: input.pendingId,
      actor: input.actor,
    });
    if (approved === null || approved.status !== "confirmed") {
      throw new Error(`Pending assistant tool action is not approvable: ${input.pendingId}`);
    }

    const toolInput = jsonObjectFromValue(approved.input);
    const execution = await this.options.tools.invoke(approved.toolId, toolInput, {
      ...toolInvocationOptions(principalForAssistantInput(input), input.request),
    });
    await this.options.confirmationGate.recordExecution({
      id: approved.id,
      actor: input.actor,
      ...(input.request?.traceId === undefined ? {} : { traceId: input.request.traceId }),
      ...(execution.ok ? { result: toJsonValue(execution.output) } : { error: execution.error }),
    });
    const toolCall: AssistantToolCallResult = execution.ok
      ? {
          toolCallId: approved.id,
          toolId: approved.toolId,
          input: toolInput,
          status: "executed",
          output: toJsonValue(execution.output),
        }
      : {
          toolCallId: approved.id,
          toolId: approved.toolId,
          input: toolInput,
          status: "failed",
          error: execution.error,
        };
    const toolMessage = await this.options.store.appendMessage({
      orgId: input.actor.orgId,
      conversationId: conversation.id,
      role: "tool",
      content: toolResultContent(toolCall),
      toolCallId: approved.id,
      metadata: toJsonObject({
        approvedPendingTool: approved,
        toolCall,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      }),
    });
    const visibleTools = await this.listVisibleTools(input.actor, input.principal);
    const history = await this.options.store.listMessages({
      orgId: input.actor.orgId,
      conversationId: conversation.id,
      limit: this.#historyLimit,
    });
    const aiResponse = await this.options.ai.chat(
      {
        feature: "assistant.chat",
        messages: [
          systemMessage({
            sources: [],
            memory: [],
            tools: visibleTools,
            slashInstruction:
              "Continue the assistant turn after the approved tool result. Summarize the executed action and any errors.",
          }),
          ...history.map(toAIMessage),
        ],
        tools: visibleTools.map((tool) => tool.id),
        classification: input.classification ?? "standard",
        metadata: toJsonObject({
          resumePendingId: approved.id,
          approvedToolId: approved.toolId,
          toolMessageId: toolMessage.id,
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        }),
      },
      aiCallContext(input.actor, input.request),
    );
    const responseMessage = await this.options.store.appendMessage({
      orgId: input.actor.orgId,
      conversationId: conversation.id,
      role: "assistant",
      content: aiResponse.message,
      metadata: toJsonObject({
        providerId: aiResponse.providerId,
        model: aiResponse.model,
        usage: aiResponse.usage ?? {},
        ...(aiResponse.metadata === undefined ? {} : { ai: aiResponse.metadata }),
        resumedPendingId: approved.id,
        toolCalls: aiResponse.toolCalls ?? [],
      }),
    });

    return {
      conversation,
      messages: await this.options.store.listMessages({
        orgId: input.actor.orgId,
        conversationId: conversation.id,
        limit: this.#historyLimit,
      }),
      response: responseMessage,
      ai: aiResponse,
      toolCalls: [toolCall],
      sources: [],
      memory: [],
      pendingConfirmations: [],
    };
  }

  async cancelPendingTool(input: AssistantCancelPendingToolInput): Promise<AssistantTurnResponse> {
    if (this.options.confirmationGate === undefined) {
      throw new Error("Assistant confirmation gate is not configured.");
    }
    const conversation = await this.options.store.getConversation({
      orgId: input.actor.orgId,
      actorId: input.actor.id,
      conversationId: input.conversationId,
    });
    if (conversation === null) {
      throw new Error(`Unknown assistant conversation: ${input.conversationId}`);
    }

    const cancelled = await this.options.confirmationGate.deny({
      id: input.pendingId,
      actor: input.actor,
    });
    if (cancelled === null || cancelled.status !== "cancelled") {
      throw new Error(`Pending assistant tool action is not cancellable: ${input.pendingId}`);
    }

    const toolInput = jsonObjectFromValue(cancelled.input);
    const toolCall: AssistantToolCallResult = {
      toolCallId: cancelled.id,
      toolId: cancelled.toolId,
      input: toolInput,
      status: "skipped",
      error: "Pending assistant tool action was cancelled by the actor.",
    };
    const toolMessage = await this.options.store.appendMessage({
      orgId: input.actor.orgId,
      conversationId: conversation.id,
      role: "tool",
      content: toolResultContent(toolCall),
      toolCallId: cancelled.id,
      metadata: toJsonObject({
        cancelledPendingTool: cancelled,
        toolCall,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      }),
    });
    const visibleTools = await this.listVisibleTools(input.actor, input.principal);
    const history = await this.options.store.listMessages({
      orgId: input.actor.orgId,
      conversationId: conversation.id,
      limit: this.#historyLimit,
    });
    const aiResponse = await this.options.ai.chat(
      {
        feature: "assistant.chat",
        messages: [
          systemMessage({
            sources: [],
            memory: [],
            tools: visibleTools,
            slashInstruction:
              "Continue the assistant turn after the actor cancelled the pending tool action. Do not claim the action executed.",
          }),
          ...history.map(toAIMessage),
        ],
        tools: visibleTools.map((tool) => tool.id),
        classification: input.classification ?? "standard",
        metadata: toJsonObject({
          resumePendingId: cancelled.id,
          cancelledToolId: cancelled.toolId,
          toolMessageId: toolMessage.id,
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        }),
      },
      aiCallContext(input.actor, input.request),
    );
    const responseMessage = await this.options.store.appendMessage({
      orgId: input.actor.orgId,
      conversationId: conversation.id,
      role: "assistant",
      content: aiResponse.message,
      metadata: toJsonObject({
        providerId: aiResponse.providerId,
        model: aiResponse.model,
        usage: aiResponse.usage ?? {},
        ...(aiResponse.metadata === undefined ? {} : { ai: aiResponse.metadata }),
        resumedPendingId: cancelled.id,
        cancelledToolId: cancelled.toolId,
        toolCalls: aiResponse.toolCalls ?? [],
      }),
    });

    return {
      conversation,
      messages: await this.options.store.listMessages({
        orgId: input.actor.orgId,
        conversationId: conversation.id,
        limit: this.#historyLimit,
      }),
      response: responseMessage,
      ai: aiResponse,
      toolCalls: [toolCall],
      sources: [],
      memory: [],
      pendingConfirmations: [],
    };
  }

  async forgetMemory(input: AssistantForgetMemoryInput): Promise<AssistantForgetMemoryResult> {
    const forgottenCount =
      (await this.options.memory?.forget(input.actor, input.criteria ?? { all: true })) ?? 0;
    let conversation: AssistantConversation | undefined;
    if (input.disableMemory === true) {
      await this.options.store.setMemoryPreference({
        actor: input.actor,
        enabled: false,
        metadata: { source: "assistant.forget" },
      });
    }
    if (input.conversationId !== undefined) {
      const existing = await this.options.store.getConversation({
        orgId: input.actor.orgId,
        actorId: input.actor.id,
        conversationId: input.conversationId,
      });
      if (existing !== null) {
        conversation = existing;
        if (input.disableMemory === true) {
          conversation =
            (await this.options.store.setConversationMemoryOptIn({
              orgId: input.actor.orgId,
              actorId: input.actor.id,
              conversationId: existing.id,
              enabled: false,
            })) ?? existing;
        }
        await this.options.store.appendMessage({
          orgId: input.actor.orgId,
          conversationId: existing.id,
          role: "system",
          content: `Forgot ${String(forgottenCount)} assistant memory item(s).`,
          metadata: toJsonObject({
            criteria: input.criteria ?? { all: true },
            disableMemory: input.disableMemory ?? false,
            ...(input.request?.traceId === undefined ? {} : { traceId: input.request.traceId }),
          }),
        });
      }
    }
    const preference = await this.options.store.getMemoryPreference(input.actor);
    return {
      forgottenCount,
      ...(conversation === undefined ? {} : { conversation }),
      ...(preference === null ? {} : { preference }),
    };
  }

  private async getOrCreateConversation(
    input: AssistantSendMessageInput,
  ): Promise<AssistantConversation> {
    if (input.conversationId !== undefined) {
      const existing = await this.options.store.getConversation({
        orgId: input.actor.orgId,
        actorId: input.actor.id,
        conversationId: input.conversationId,
      });
      if (existing === null) {
        throw new Error(`Unknown assistant conversation: ${input.conversationId}`);
      }
      return existing;
    }
    return this.options.store.createConversation({
      actor: input.actor,
      title: input.title ?? titleFromContent(input.content),
      ...(input.memoryOptIn === undefined ? {} : { memoryOptIn: input.memoryOptIn }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
  }

  private async collectSearchContext(
    actor: Actor,
    query: string,
  ): Promise<readonly AssistantSource[]> {
    const trimmed = query.trim();
    if (this.options.search === undefined || trimmed.length === 0) {
      return [];
    }
    // RAG retrieval MUST run through createScopedSearchRequest so the
    // request carries (a) the org filter so we never cross tenants, and (b)
    // the authenticated forActorId so the vector store surfaces the actor's
    // own visibility="private" embeddings on top of every org-shared one.
    const request = createScopedSearchRequest(actor, {
      query: trimmed,
      limit: this.#searchLimit,
    });
    if (request === undefined) {
      // Actor has zero search-readable scopes — return nothing rather than
      // a wide-open query.
      return [];
    }
    const response = await this.options.search.search(request);
    return response.hits.map(searchHitToAssistantSource);
  }

  private async collectMemoryContext(
    actor: Actor,
    conversation: AssistantConversation,
    query: string,
  ): Promise<readonly MemoryItem[]> {
    if (
      this.options.memory === undefined ||
      !conversation.memoryOptIn ||
      query.trim().length === 0
    ) {
      return [];
    }
    return this.options.memory.recall(actor, query, this.#memoryLimit);
  }

  private async listVisibleTools(
    actor: Actor,
    principal?: ToolInvocationPrincipal,
  ): Promise<readonly AssistantVisibleTool[]> {
    const tools = await this.options.tools.listVisible(actor);
    return tools.map((tool) => ({
      id: tool.id,
      description: tool.description,
      permission: tool.permission,
      sideEffects: tool.sideEffects,
      confirmationRequired: requiresAssistantConfirmation(tool, principal),
      inputSchema: tool.inputSchema.toJsonSchema(),
    }));
  }

  private async invokeToolCall(input: {
    readonly actor: Actor;
    readonly principal: ToolInvocationPrincipal;
    readonly request?: RequestContext;
    readonly visibleTools: readonly AssistantVisibleTool[];
    readonly toolCallId: string;
    readonly toolId: string;
    readonly input: JsonObject;
  }): Promise<AssistantToolCallResult> {
    const visible = input.visibleTools.find((tool) => tool.id === input.toolId);
    const tool = this.options.tools.get(input.toolId);
    if (visible === undefined || tool === undefined) {
      return {
        toolCallId: input.toolCallId,
        toolId: input.toolId,
        input: input.input,
        status: "skipped",
        error: `Tool is not visible to actor: ${input.toolId}`,
      };
    }

    if (requiresAssistantConfirmation(tool, input.principal)) {
      const pending =
        this.options.confirmationGate === undefined
          ? syntheticPendingConfirmation(input.actor, tool.id, input.input, input.request)
          : await this.options.confirmationGate.queue({
              tool,
              actor: input.actor,
              input: toJsonValue(input.input),
              ...(input.request === undefined ? {} : { request: input.request }),
              ...(input.request?.traceId === undefined ? {} : { traceId: input.request.traceId }),
            });
      return {
        toolCallId: input.toolCallId,
        toolId: input.toolId,
        input: input.input,
        status: "pending_confirmation",
        pending,
      };
    }

    const result = await this.options.tools.invoke(input.toolId, input.input, {
      ...toolInvocationOptions(input.principal, input.request),
    });
    if (!result.ok) {
      return {
        toolCallId: input.toolCallId,
        toolId: input.toolId,
        input: input.input,
        status: "failed",
        error: result.error,
      };
    }
    return {
      toolCallId: input.toolCallId,
      toolId: input.toolId,
      input: input.input,
      status: "executed",
      output: toJsonValue(result.output),
    };
  }

  private async rememberTurn(
    actor: Actor,
    conversation: AssistantConversation,
    userContent: string,
    assistantContent: string,
  ): Promise<void> {
    if (this.options.memory === undefined || !conversation.memoryOptIn) {
      return;
    }
    await this.options.memory.store(actor, {
      source: "assistant.conversation",
      content: `User: ${userContent}\nAssistant: ${assistantContent}`,
      metadata: { conversationId: conversation.id },
    });
  }
}

function systemMessage(input: {
  readonly sources: readonly AssistantSource[];
  readonly memory: readonly MemoryItem[];
  readonly tools: readonly AssistantVisibleTool[];
  readonly slashInstruction?: string;
}): AIMessage {
  const sections = [
    "You are Helix Assistant. Use only visible tools and retrieved context available to the current actor.",
    "Destructive or external communication tools require confirmation before execution.",
  ];
  if (input.slashInstruction !== undefined) {
    sections.push(`Slash command instruction:\n${input.slashInstruction}`);
  }
  if (input.sources.length > 0) {
    sections.push(`Search context:\n${input.sources.map(formatSource).join("\n")}`);
  }
  if (input.memory.length > 0) {
    sections.push(`Opt-in memory context:\n${input.memory.map(formatMemory).join("\n")}`);
  }
  if (input.tools.length > 0) {
    sections.push(`Visible tools:\n${input.tools.map(formatTool).join("\n")}`);
  }
  return { role: "system", content: sections.join("\n\n") };
}

function routeVisibleTools(
  tools: readonly AssistantVisibleTool[],
  routeToolIds: readonly string[] | undefined,
): readonly AssistantVisibleTool[] {
  if (routeToolIds === undefined) {
    return tools;
  }
  const routeToolIdSet = new Set(routeToolIds);
  return tools.filter((tool) => routeToolIdSet.has(tool.id));
}

function toAIMessage(message: {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string | null;
}): AIMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.role === "tool" && message.toolCallId !== undefined && message.toolCallId !== null
      ? { name: message.toolCallId }
      : {}),
  };
}

function aiCallContext(actor: Actor, request: RequestContext | undefined): Partial<AICallContext> {
  return {
    actor,
    feature: "assistant.chat",
    classification: "standard",
    ...(request === undefined ? {} : { trace: request }),
  };
}

function requiresAssistantConfirmation(
  tool: ToolDefinition,
  principal?: ToolInvocationPrincipal,
): boolean {
  if (principal?.actor.type === "agent") {
    return tool.sideEffects !== "read";
  }
  const confirmationOverride = principal?.credentialPolicy?.confirmationOverride;
  if (confirmationOverride === "always") {
    return true;
  }
  if (confirmationOverride === "never") {
    return false;
  }
  return (
    tool.confirmationRequired === true ||
    tool.sideEffects === "destructive" ||
    tool.sideEffects === "external_communication"
  );
}

function principalForAssistantInput(input: {
  readonly actor: Actor;
  readonly principal?: ToolInvocationPrincipal;
}): ToolInvocationPrincipal {
  return input.principal ?? actorToolInvocationPrincipal(input.actor);
}

function syntheticPendingConfirmation(
  actor: Actor,
  toolId: string,
  input: JsonObject,
  request: RequestContext | undefined,
): PendingToolInvocation {
  const now = new Date();
  return {
    id: randomUUID(),
    toolId,
    actorId: actor.id,
    input,
    status: "pending_confirmation",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
    ...(request?.traceId === undefined ? {} : { traceId: request.traceId }),
  };
}

function formatSource(source: AssistantSource): string {
  return `- [${source.type}] ${source.title ?? source.id}: ${source.body ?? source.url ?? ""}`.trim();
}

function formatMemory(memory: MemoryItem): string {
  return `- ${memory.content}`;
}

function formatTool(tool: AssistantVisibleTool): string {
  const confirmation = tool.confirmationRequired ? " confirmation_required" : "";
  return `- ${tool.id} (${tool.sideEffects}${confirmation}): ${tool.description}`;
}

function toolResultContent(result: AssistantToolCallResult): string {
  if (result.status === "executed") {
    return JSON.stringify({ toolId: result.toolId, output: result.output });
  }
  if (result.status === "pending_confirmation") {
    return JSON.stringify({ toolId: result.toolId, pending: result.pending });
  }
  return JSON.stringify({ toolId: result.toolId, status: result.status, error: result.error });
}

function titleFromContent(content: string): string {
  const compact = content.trim().replace(/\s+/g, " ");
  return compact.length <= 80 ? compact : `${compact.slice(0, 77)}...`;
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function toJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value ?? {})) as JsonObject;
}

function jsonObjectFromValue(value: JsonValue): JsonObject {
  if (isJsonObject(value)) {
    return value;
  }
  throw new TypeError("Assistant pending tool input must be a JSON object.");
}

/** Extracts assembled tool calls from a streamed final chunk's metadata. */
function toolCallsFromStreamMetadata(
  metadata: JsonObject | undefined,
): readonly AIToolChoice[] | undefined {
  const value = metadata?.toolCalls;
  if (!Array.isArray(value)) {
    return undefined;
  }
  const toolCalls = value.flatMap((entry): AIToolChoice[] => {
    if (!isJsonObject(entry) || typeof entry.id !== "string") {
      return [];
    }
    const input: unknown = entry.input;
    const id = entry.id;
    if (typeof input === "object" && input !== null && !Array.isArray(input)) {
      return [{ id, input: toJsonObject(input) }];
    }
    return [{ id }];
  });
  return toolCalls.length === 0 ? undefined : toolCalls;
}
