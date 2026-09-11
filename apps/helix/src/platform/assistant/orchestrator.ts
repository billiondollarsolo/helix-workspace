import {
  systemMessage,
  routeVisibleTools,
  effectiveClassificationForTurn,
  toAIMessage,
  aiCallContext,
  prepareVisibleTools,
  finishToolPrompt,
  untrustedContextMessages,
  principalForAssistantInput,
  toolResultContent,
  titleFromContent,
  toJsonValue,
  toJsonObject,
} from "./orchestrator-prompt.js";
import { BadRequestError, NotFoundError } from "../../api/api-error.js";
import { projectAssistantMessages } from "./attachments.js";
import type {
  Actor,
  AICapability,
  AIMessage,
  ChatResponse,
  JsonObject,
  PendingToolInvocation,
  JsonValue,
  RequestContext,
} from "@helix/sdk-types";
import { randomUUID } from "node:crypto";
import { isJsonObject } from "@helix/sdk-types";
import { assistantToolGroups, selectedToolGroups } from "./tool-selection.js";
import { projectAssistantWebSources } from "./tool-sources.js";
import { promptHistory, streamChatTurn } from "./tool-loop.js";
import { maxClassification, type DataClassification } from "../ai/classification/index.js";
import type { MemoryItem, MemoryStore } from "../ai/memory/index.js";
import {
  toolInvocationOptions,
  type ToolInvocationPrincipal,
} from "../auth/tool-invocation-principal.js";
import type { SearchEngine } from "../search/index.js";
import type { GlobalSearchType } from "../search/scope.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import type { ConfirmationGate } from "../tools/registry.js";
import {
  classificationAttribute,
  classificationFromToolResult,
  collectSearchContext,
  prepareMemoryContext,
} from "./context-policy.js";
import {
  parseAssistantSlashCommand,
  resolveDefaultAssistantSlashCommand,
  type AssistantSlashCommandHooks,
} from "./slash.js";
import type {
  AssistantApprovePendingToolInput,
  AssistantCancelPendingToolInput,
  AssistantConversation,
  AssistantForgetMemoryInput,
  AssistantForgetMemoryResult,
  AssistantMessage,
  AssistantLoadedAttachment,
  AssistantModelCatalog,
  AssistantSendMessageInput,
  AssistantStore,
  AssistantStreamEvent,
  AssistantToolCallResult,
  AssistantToolResultClassifier,
  AssistantTurnResponse,
  AssistantVisibleTool,
  AssistantSource,
  AssistantToolActivity,
} from "./types.js";

export interface AssistantOrchestratorOptions {
  readonly store: AssistantStore;
  readonly ai: AICapability;
  readonly listModels?: () => AssistantModelCatalog | Promise<AssistantModelCatalog>;
  readonly webSearchEnabled?: (classification?: DataClassification) => boolean;
  readonly loadAttachments?: (input: {
    readonly actor: Actor;
    readonly objectIds: readonly string[];
    readonly signal?: AbortSignal;
  }) => Promise<readonly AssistantLoadedAttachment[]>;
  readonly tools: RuntimeToolRegistry;
  readonly search?: SearchEngine;
  /** Server-enabled application types eligible for retrieval context. */
  readonly searchTypes?: readonly GlobalSearchType[];
  readonly memory?: MemoryStore;
  readonly confirmationGate?: ConfirmationGate;
  readonly slashCommands?: AssistantSlashCommandHooks;
  readonly maxToolRounds?: number;
  readonly getMaxToolRounds?: () => number;
  readonly historyLimit?: number;
  readonly searchLimit?: number;
  readonly memoryLimit?: number;
  /** Optional deterministic block for destructive/external calls influenced by retrieval. */
  readonly blockHighRiskToolsWhenUntrusted?: boolean;
  /** Server-owned classifier for the current user message; client hints are never passed to it. */
  readonly classifyUserInput?: (input: {
    readonly actor: Actor;
    readonly content: string;
  }) => Promise<DataClassification>;
  readonly classifyToolResult?: AssistantToolResultClassifier;
}

interface TurnSettings {
  readonly webSearch: boolean;
  readonly toolGroups: readonly string[];
  readonly timeZone?: JsonValue;
  readonly slashInstruction?: string;
  readonly toolIds?: readonly string[];
  readonly usedToolRounds?: number;
  readonly maxToolRounds?: number;
  readonly originMessageId?: string;
}

export class AssistantOrchestrator {
  readonly #historyLimit: number;
  readonly #searchLimit: number;
  readonly #memoryLimit: number;

  constructor(private readonly options: AssistantOrchestratorOptions) {
    this.#historyLimit = options.historyLimit ?? 24;
    this.#searchLimit = options.searchLimit ?? 5;
    this.#memoryLimit = options.memoryLimit ?? 5;
  }

  async listModels(): Promise<AssistantModelCatalog> {
    const catalog = (await this.options.listModels?.()) ?? { models: [] };
    return this.options.webSearchEnabled === undefined
      ? catalog
      : { ...catalog, webSearchEnabled: this.options.webSearchEnabled() };
  }

  async listToolGroups(actor: Actor) {
    return assistantToolGroups(await this.listVisibleTools(actor));
  }

  async #selectModel(modelId?: string) {
    const catalog = await this.listModels();
    const selected = modelId ?? catalog.defaultModelId;
    const model = catalog.models.find((entry) => entry.id === selected);
    if (selected !== undefined && model === undefined)
      throw new BadRequestError(
        "The selected model is unavailable. Refresh the model list and choose another model.",
      );
    return model;
  }

  async #loadAttachments(
    actor: Actor,
    history: readonly AssistantMessage[],
    current: readonly string[] = [],
    signal?: AbortSignal,
  ): Promise<readonly AssistantLoadedAttachment[]> {
    const objectIds = [
      ...new Set([
        ...history.flatMap((message) =>
          (message.attachments ?? []).map(({ objectId }) => objectId),
        ),
        ...current,
      ]),
    ];
    if (objectIds.length === 0) return [];
    if (this.options.loadAttachments === undefined)
      throw new BadRequestError(
        "Assistant file attachments are not configured. Remove the files and try again.",
      );
    return this.options.loadAttachments({
      actor,
      objectIds,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async getConversation(actor: Actor, conversationId: string) {
    const conversation = await this.#requireConversation(actor, conversationId);
    return {
      conversation,
      messages: await this.#conversationMessages(actor.orgId, conversationId),
    };
  }

  async sendMessage(input: AssistantSendMessageInput): Promise<AssistantTurnResponse> {
    // Drain buffered mode to its return value.
    const turn = this.#runTurn(input, "buffered");
    let step = await turn.next();
    while (!step.done) step = await turn.next();
    return step.value;
  }

  async *sendMessageStream(input: AssistantSendMessageInput): AsyncGenerator<AssistantStreamEvent> {
    const turn = yield* this.#runTurn(input, "streaming");
    yield { type: "final", turn };
  }

  async *#runTurn(
    input: AssistantSendMessageInput,
    mode: "buffered" | "streaming",
  ): AsyncGenerator<AssistantStreamEvent, AssistantTurnResponse> {
    input.signal?.throwIfAborted();
    if (input.webSearch && !this.options.webSearchEnabled?.())
      throw new BadRequestError("Web search is disabled by administrator policy.");
    const toolGroups = selectedToolGroups(input.toolGroups);
    const model = await this.#selectModel(input.modelId);
    const existing =
      input.conversationId === undefined
        ? null
        : await this.#requireConversation(input.actor, input.conversationId);
    let previous =
      existing === null ? [] : await this.#recentMessages(input.actor.orgId, existing.id);
    if (input.editMessageId !== undefined) {
      if (existing === null)
        throw new BadRequestError("Editing a message requires its conversation.");
      // ponytail: bound branch copying at 1,000 messages; use SQL cloning for longer histories.
      const messages = projectAssistantMessages(
        await this.options.store.listMessages({
          orgId: input.actor.orgId,
          conversationId: existing.id,
          limit: 1001,
        }),
      );
      if (messages.length > 1000)
        throw new BadRequestError(
          "This conversation is too long to branch. Start a new conversation with your revised message.",
        );
      const index = messages.findIndex((message) => message.id === input.editMessageId);
      const edited = messages[index];
      if (edited === undefined || edited.role !== "user" || edited.actorId !== input.actor.id)
        throw new NotFoundError("The user message to edit was not found in this conversation.");
      previous = messages.slice(0, index);
    }
    const loaded = await this.#loadAttachments(
      input.actor,
      previous.slice(-this.#historyLimit),
      input.attachmentObjectIds,
      input.signal,
    );
    const attached = loaded.filter(({ attachment }) =>
      input.attachmentObjectIds?.includes(attachment.objectId),
    );
    const userInputClassification =
      (await this.options.classifyUserInput?.({
        actor: input.actor,
        content: input.content,
      })) ?? "standard";
    const memoryOptIn = input.memoryOptIn ?? existing?.memoryOptIn;
    let conversation =
      (input.editMessageId === undefined ? existing : null) ??
      (await this.options.store.createConversation({
        actor: input.actor,
        title: input.title ?? titleFromContent(input.content),
        ...(memoryOptIn === undefined ? {} : { memoryOptIn }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      }));
    if (input.editMessageId !== undefined) {
      const startedAt = Date.now() - previous.length;
      for (const [index, message] of previous.entries()) {
        await this.options.store.appendMessage({
          orgId: input.actor.orgId,
          conversationId: conversation.id,
          actorId: message.actorId,
          role: message.role,
          content: message.content,
          toolCallId: message.toolCallId,
          metadata: message.metadata,
          createdAt: new Date(startedAt + index),
        });
      }
    }
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
    const settings: TurnSettings = {
      webSearch: input.webSearch === true,
      toolGroups,
      ...(input.metadata?.timeZone === undefined ? {} : { timeZone: input.metadata.timeZone }),
      ...(slashHook?.instruction === undefined ? {} : { slashInstruction: slashHook.instruction }),
      ...(slashHook?.toolIds === undefined ? {} : { toolIds: slashHook.toolIds }),
    };
    const userMessage = await this.options.store.appendMessage({
      orgId: input.actor.orgId,
      conversationId: conversation.id,
      actorId: input.actor.id,
      role: "user",
      content: input.content,
      metadata: toJsonObject({
        ...(input.metadata ?? {}),
        attachments: attached.map(({ attachment }) => attachment),
        selectedModelId: model?.id ?? null,
        webSearch: settings.webSearch,
        toolGroups,
        assistantTurn: settings,
        ...(slashCommand === null ? {} : { slashCommand }),
        effectiveClassification: loaded.reduce(
          (classification, { source }) => maxClassification(classification, source.classification),
          maxClassification(userInputClassification, input.classification ?? "standard"),
        ),
      }),
    });
    const searchQuery =
      slashHook?.searchQuery !== undefined
        ? slashHook.searchQuery
        : slashCommand === null
          ? input.content
          : slashCommand.args.trim();
    const sources = loaded.map(({ source }) => source);
    const history = [...previous, userMessage].slice(-this.#historyLimit);
    let effectiveClassification = effectiveClassificationForTurn({
      orgId: input.actor.orgId,
      ...(input.classification === undefined ? {} : { clientHint: input.classification }),
      userInputClassification,
      conversation,
      history,
      sources,
      memory: [],
    });
    const [recalledMemory, allVisibleTools] = await Promise.all([
      this.collectMemoryContext(input.actor, conversation, searchQuery, effectiveClassification),
      this.listVisibleTools(input.actor, input.principal, input.webSearch),
    ]);
    for (const item of recalledMemory)
      effectiveClassification = maxClassification(
        effectiveClassification,
        classificationAttribute(item.metadata),
      );
    // Public web search does not implicitly attach unrelated workspace records.
    const retrievedSources =
      input.webSearch === true
        ? []
        : await collectSearchContext(
            this.options.search,
            input.actor,
            searchQuery,
            effectiveClassification,
            this.#searchLimit,
            this.options.searchTypes,
          );
    sources.unshift(...retrievedSources);
    for (const source of retrievedSources)
      effectiveClassification = maxClassification(effectiveClassification, source.classification);
    const visibleTools = routeVisibleTools(allVisibleTools, settings.toolIds, settings.toolGroups);
    return yield* this.#continueTurn({
      input,
      mode,
      conversation,
      model,
      settings: { ...settings, originMessageId: userMessage.id },
      visibleTools,
      sources,
      memory: recalledMemory,
      history,
      effectiveClassification,
      responseMetadata: toJsonObject({
        ...(slashCommand === null ? {} : { slashCommand }),
        ...(slashHook?.metadata === undefined ? {} : { slashMetadata: slashHook.metadata }),
        ...(slashHook?.toolIds === undefined ? {} : { slashToolIds: slashHook.toolIds }),
      }),
    });
  }

  async *#continueTurn(context: {
    readonly input: AssistantSendMessageInput;
    readonly mode: "buffered" | "streaming";
    readonly conversation: AssistantConversation;
    readonly model: AssistantModelCatalog["models"][number] | undefined;
    readonly settings: TurnSettings;
    readonly visibleTools: readonly AssistantVisibleTool[];
    readonly sources: readonly AssistantSource[];
    readonly memory: readonly MemoryItem[];
    readonly history: readonly AssistantMessage[];
    readonly effectiveClassification: DataClassification;
    readonly initialToolCalls?: readonly AssistantToolCallResult[];
    readonly responseMetadata?: JsonObject;
  }): AsyncGenerator<AssistantStreamEvent, AssistantTurnResponse> {
    const { input, mode, conversation, model, settings, visibleTools, memory } = context;
    const maxRounds =
      settings.maxToolRounds ??
      this.options.getMaxToolRounds?.() ??
      this.options.maxToolRounds ??
      128;
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 256)
      throw new BadRequestError("Assistant tool iterations must be an integer from 1 to 256.");
    let effectiveClassification = context.effectiveClassification;
    let sources = [...context.sources];
    const toolCalls: AssistantToolCallResult[] = [...(context.initialToolCalls ?? [])];
    const pendingConfirmations: PendingToolInvocation[] = [];
    const promptMessages: AIMessage[] = [
      systemMessage({ tools: visibleTools, ...settings }),
      ...untrustedContextMessages(sources, memory),
      ...promptHistory(context.history).map(toAIMessage),
    ];
    let aiResponse: ChatResponse | undefined;
    let responseMessage: AssistantMessage | undefined;
    for (
      let round = Math.min(settings.usedToolRounds ?? 0, maxRounds);
      round <= maxRounds;
      round += 1
    ) {
      input.signal?.throwIfAborted();
      const roundTools = round === maxRounds ? [] : visibleTools;
      if (round === maxRounds)
        finishToolPrompt(promptMessages, settings.timeZone, settings.slashInstruction);
      const sourceIds = sources.map((source) => source.provenance.sourceId);
      const chatRequest = {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(model === undefined ? {} : { model: model.model }),
        feature: "assistant.chat",
        messages: promptMessages,
        tools: roundTools.map((tool) => tool.id),
        classification: effectiveClassification,
        metadata: toJsonObject({
          ...(model === undefined ? {} : { providerId: model.providerId }),
          visibleTools: roundTools,
          sourceIds,
          memoryIds: memory.map((item) => item.id),
          effectiveClassification,
          ...context.responseMetadata,
        }),
      };
      const callContext = aiCallContext(input.actor, input.request, effectiveClassification);
      aiResponse =
        mode === "streaming"
          ? yield* streamChatTurn(this.options.ai, chatRequest, callContext, round)
          : await this.options.ai.chat(chatRequest, callContext);
      input.signal?.throwIfAborted();
      if (
        (round === maxRounds && aiResponse.toolCalls?.length) ||
        (!aiResponse.toolCalls?.length && !aiResponse.message.trim())
      )
        throw new BadRequestError(
          "The model did not finish its answer. Try a more focused request or another model.",
        );
      if (aiResponse.toolCalls !== undefined)
        aiResponse = {
          ...aiResponse,
          toolCalls: aiResponse.toolCalls.map((call) => ({
            ...call,
            callId: call.callId ?? randomUUID(),
          })),
        };
      const roundResults: AssistantToolCallResult[] = [];
      for (const call of aiResponse.toolCalls ?? []) {
        input.signal?.throwIfAborted();
        const toolCallId = call.callId ?? randomUUID();
        yield { type: "tool", toolCallId, toolId: call.id, status: "running" };
        const result: AssistantToolCallResult =
          call.error === undefined
            ? await this.invokeToolCall({
                actor: input.actor,
                principal: principalForAssistantInput(input),
                visibleTools: roundTools,
                toolCallId,
                toolId: call.id,
                input: call.input ?? {},
                effectiveClassification,
                sourceIds: sources.map((source) => source.provenance.sourceId),
                ...(input.request === undefined ? {} : { request: input.request }),
              })
            : { toolCallId, toolId: call.id, input: {}, status: "failed", error: call.error };
        input.signal?.throwIfAborted();
        roundResults.push(result);
        toolCalls.push(result);
        if (result.status === "executed")
          effectiveClassification = maxClassification(
            effectiveClassification,
            result.classification ?? classificationFromToolResult(result.output),
          );
        if (result.pending !== undefined) pendingConfirmations.push(result.pending);
        sources = [
          ...sources.filter(
            (source) => source.type !== "web.search" && source.type !== "web.fetch",
          ),
          ...projectAssistantWebSources({
            orgId: input.actor.orgId,
            toolCalls: [result],
            existingSources: sources,
          }),
        ];
        yield { type: "tool", ...toolActivity(result) };
      }
      const savedSettings = {
        ...settings,
        maxToolRounds: maxRounds,
        usedToolRounds: round + (aiResponse.toolCalls?.length ? 1 : 0),
      };
      responseMessage = await this.options.store.appendMessage({
        orgId: input.actor.orgId,
        conversationId: conversation.id,
        role: "assistant",
        content: aiResponse.message,
        metadata: toJsonObject({
          selectedModelId: model?.id ?? null,
          providerId: aiResponse.providerId,
          model: aiResponse.model,
          usage: aiResponse.usage ?? {},
          ...(mode === "streaming" ? { streamed: true } : {}),
          effectiveClassification,
          ...(aiResponse.metadata === undefined ? {} : { ai: aiResponse.metadata }),
          toolCalls: aiResponse.toolCalls ?? [],
          toolActivity: toolCalls.map(toolActivity),
          sources: sources.map(({ body: _body, ...source }) => source),
          assistantTurn: savedSettings,
          ...context.responseMetadata,
        }),
      });
      promptMessages.push(toAIMessage(responseMessage));
      for (const result of roundResults) {
        const message = await this.options.store.appendMessage({
          orgId: input.actor.orgId,
          conversationId: conversation.id,
          role: "tool",
          content: toolResultContent(result),
          toolCallId: result.toolCallId,
          metadata: toJsonObject({
            toolCall: result,
            effectiveClassification,
            assistantTurn: savedSettings,
          }),
        });
        promptMessages.push(toAIMessage(message));
      }
      if (!aiResponse.toolCalls?.length || pendingConfirmations.length > 0) break;
    }
    if (aiResponse === undefined || responseMessage === undefined)
      throw new Error("Assistant did not produce a response.");
    await this.rememberTurn(
      input.actor,
      conversation,
      input.content,
      responseMessage.content,
      effectiveClassification,
    );
    return {
      conversation,
      messages: await this.#conversationMessages(input.actor.orgId, conversation.id),
      response: projectAssistantMessages([responseMessage])[0] ?? responseMessage,
      ai: aiResponse,
      toolCalls,
      sources,
      memory,
      pendingConfirmations,
      effectiveClassification,
    };
  }

  async approvePendingTool(
    input: AssistantApprovePendingToolInput,
  ): Promise<AssistantTurnResponse> {
    return this.#resumePendingTool(input, true);
  }

  async cancelPendingTool(input: AssistantCancelPendingToolInput): Promise<AssistantTurnResponse> {
    return this.#resumePendingTool(input, false);
  }

  async #resumePendingTool(
    input: AssistantApprovePendingToolInput | AssistantCancelPendingToolInput,
    approve: boolean,
  ): Promise<AssistantTurnResponse> {
    if (this.options.confirmationGate === undefined)
      throw new Error("Assistant confirmation gate is not configured.");
    const conversation = await this.#requireConversation(input.actor, input.conversationId);
    const pendingContext = await this.options.store.getPendingTurnContext({
      orgId: input.actor.orgId,
      actorId: input.actor.id,
      conversationId: conversation.id,
      pendingId: input.pendingId,
      limit: this.#historyLimit,
    });
    if (pendingContext === null)
      throw new NotFoundError("The pending action was not found in this conversation.");
    const { pending: pendingMessage, origin } = pendingContext;
    const originHistory = projectAssistantMessages([
      origin,
      ...pendingContext.history.filter(
        (message) =>
          ![origin.id, pendingMessage.id, pendingContext.assistant.id].includes(message.id),
      ),
      pendingContext.assistant,
      pendingMessage,
    ]);
    const saved = isJsonObject(pendingMessage.metadata.assistantTurn)
      ? pendingMessage.metadata.assistantTurn
      : origin.metadata;
    const settings: TurnSettings = {
      originMessageId: origin.id,
      webSearch: saved.webSearch === true,
      ...(typeof saved.maxToolRounds === "number" ? { maxToolRounds: saved.maxToolRounds } : {}),
      ...(typeof saved.usedToolRounds === "number" &&
      Number.isInteger(saved.usedToolRounds) &&
      saved.usedToolRounds >= 0
        ? { usedToolRounds: saved.usedToolRounds }
        : {}),
      toolGroups: selectedToolGroups(
        Array.isArray(saved.toolGroups)
          ? saved.toolGroups.filter((value): value is string => typeof value === "string")
          : undefined,
      ),
      ...(saved.timeZone === undefined ? {} : { timeZone: saved.timeZone }),
      ...(typeof saved.slashInstruction === "string"
        ? { slashInstruction: saved.slashInstruction }
        : {}),
      ...(Array.isArray(saved.toolIds)
        ? { toolIds: saved.toolIds.filter((value): value is string => typeof value === "string") }
        : {}),
    };
    const selectedModelId = pendingContext.assistant.metadata.selectedModelId;
    const model = await this.#selectModel(
      typeof selectedModelId === "string" ? selectedModelId : undefined,
    );
    const sources = [
      ...(await this.#loadAttachments(input.actor, originHistory)).map(({ source }) => source),
      ...projectAssistantWebSources({
        orgId: input.actor.orgId,
        toolCalls: [],
        existingSources: projectAssistantMessages([pendingContext.assistant])[0]?.sources ?? [],
      }),
    ];
    const pendingStatus = await this.options.tools.getPendingAction(input.pendingId, {
      actor: input.actor,
    });
    if (!pendingStatus.ok) throw new BadRequestError("The pending action is no longer available.");
    const pending = pendingStatus.pending;
    const toolCallId = pendingMessage.toolCallId ?? input.pendingId;
    let toolCall: AssistantToolCallResult;
    if (approve) {
      const execution = await this.options.tools.approvePending(input.pendingId, {
        ...toolInvocationOptions(principalForAssistantInput(input), input.request),
      });
      toolCall = execution.ok
        ? {
            toolCallId,
            toolId: pending.toolId,
            input: toJsonObject({ preview: pending.preview }),
            status: "executed",
            output: toJsonValue(execution.output),
            classification: await this.classifyToolResult(
              input.actor,
              pending.toolId,
              execution.output,
            ),
          }
        : {
            toolCallId,
            toolId: pending.toolId,
            input: toJsonObject({ preview: pending.preview }),
            status: "failed",
            error: execution.error,
            statusCode: execution.statusCode,
          };
    } else {
      const cancelled = await this.options.confirmationGate.deny({
        id: input.pendingId,
        actor: input.actor,
      });
      if (cancelled?.status !== "cancelled")
        throw new BadRequestError("The pending action is no longer cancellable.");
      toolCall = {
        toolCallId,
        toolId: pending.toolId,
        input: toJsonObject({ preview: pending.preview }),
        status: "skipped",
        error: "Pending assistant tool action was cancelled by the actor.",
      };
    }
    const resolvedMessage = await this.options.store.appendMessage({
      orgId: input.actor.orgId,
      conversationId: conversation.id,
      role: "tool",
      content: toolResultContent(toolCall),
      toolCallId,
      metadata: toJsonObject({
        toolCall,
        effectiveClassification:
          toolCall.classification ??
          pendingMessage.metadata.effectiveClassification ??
          "restricted",
        assistantTurn: settings,
        ...(approve
          ? { approvedPendingTool: pending }
          : { cancelledPendingTool: { ...pending, status: "cancelled" } }),
      }),
    });
    const history = promptHistory([...originHistory, resolvedMessage]);
    const effectiveClassification = effectiveClassificationForTurn({
      orgId: input.actor.orgId,
      conversation,
      history,
      sources,
      memory: [],
      toolResults: [toolCall],
      ...(input.classification === undefined ? {} : { clientHint: input.classification }),
    });
    const continuation = this.#continueTurn({
      input: {
        ...input,
        content: origin.content,
        webSearch: settings.webSearch,
        toolGroups: settings.toolGroups,
      },
      mode: "buffered",
      conversation,
      model,
      settings,
      visibleTools: routeVisibleTools(
        await this.listVisibleTools(input.actor, input.principal, settings.webSearch),
        settings.toolIds,
        settings.toolGroups,
      ),
      sources,
      memory: [],
      history,
      effectiveClassification,
      initialToolCalls: [toolCall],
      responseMetadata: {
        resumedPendingId: input.pendingId,
        ...(approve ? { approvedToolId: pending.toolId } : { cancelledToolId: pending.toolId }),
      },
    });
    let step = await continuation.next();
    while (!step.done) step = await continuation.next();
    return step.value;
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

  async #requireConversation(actor: Actor, conversationId: string): Promise<AssistantConversation> {
    const conversation = await this.options.store.getConversation({
      orgId: actor.orgId,
      actorId: actor.id,
      conversationId,
    });
    if (conversation === null) {
      throw new NotFoundError(`Unknown assistant conversation: ${conversationId}`);
    }
    return conversation;
  }

  async #recentMessages(
    orgId: string,
    conversationId: string,
  ): Promise<readonly AssistantMessage[]> {
    return projectAssistantMessages(
      await this.options.store.listMessages({ orgId, conversationId, limit: this.#historyLimit }),
    );
  }

  async #conversationMessages(
    orgId: string,
    conversationId: string,
  ): Promise<readonly AssistantMessage[]> {
    return projectAssistantMessages(
      await this.options.store.listMessages({ orgId, conversationId, limit: 100 }),
    );
  }

  private async collectMemoryContext(
    actor: Actor,
    conversation: AssistantConversation,
    query: string,
    classification: DataClassification,
  ): Promise<readonly MemoryItem[]> {
    if (
      this.options.memory === undefined ||
      !conversation.memoryOptIn ||
      query.trim().length === 0
    ) {
      return [];
    }
    return prepareMemoryContext(
      await this.options.memory.recall(actor, query, this.#memoryLimit, classification),
      actor.orgId,
    );
  }

  private async listVisibleTools(
    actor: Actor,
    principal?: ToolInvocationPrincipal,
    webSearch = false,
  ): Promise<readonly AssistantVisibleTool[]> {
    return prepareVisibleTools(
      await this.options.tools.listVisible(actor),
      principal,
      webSearch && this.options.webSearchEnabled?.() === true,
    );
  }

  private async invokeToolCall(input: {
    readonly actor: Actor;
    readonly principal: ToolInvocationPrincipal;
    readonly request?: RequestContext;
    readonly visibleTools: readonly AssistantVisibleTool[];
    readonly toolCallId: string;
    readonly toolId: string;
    readonly input: JsonObject;
    readonly effectiveClassification: DataClassification;
    readonly sourceIds: readonly string[];
  }): Promise<AssistantToolCallResult> {
    const visible = input.visibleTools.find(
      (tool) =>
        tool.id === input.toolId &&
        (!["web.search", "web.fetch"].includes(tool.id) ||
          (this.options.webSearchEnabled?.(input.effectiveClassification) &&
            ["public", "standard"].includes(input.effectiveClassification))),
    );
    const tool = this.options.tools.get(input.toolId);
    if (visible === undefined || tool === undefined) {
      return {
        toolCallId: input.toolCallId,
        toolId: input.toolId,
        input: input.input,
        status: "skipped",
        error: `Tool is not visible to actor: ${input.toolId}`,
        sourceIds: input.sourceIds,
      };
    }

    const result = await this.options.tools.invoke(input.toolId, input.input, {
      ...toolInvocationOptions(input.principal, input.request),
      enforceConfirmation: true,
      policyContext: {
        effectiveClassification: input.effectiveClassification,
        sourceIds: input.sourceIds,
        containsUntrustedContext: input.sourceIds.length > 0,
        requestChannel: "assistant",
        tenantId: input.actor.orgId,
        blockHighRiskWhenUntrusted: this.options.blockHighRiskToolsWhenUntrusted ?? false,
      },
    });
    if (!result.ok) {
      return {
        toolCallId: input.toolCallId,
        toolId: input.toolId,
        input: input.input,
        status: "failed",
        error: result.error,
        statusCode: result.statusCode,
        ...(result.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: result.retryAfterSeconds }),
        sourceIds: input.sourceIds,
      };
    }
    if (result.status === "pending_confirmation") {
      return {
        toolCallId: input.toolCallId,
        toolId: input.toolId,
        input: input.input,
        status: "pending_confirmation",
        pending: result.pending,
        sourceIds: input.sourceIds,
      };
    }
    return {
      toolCallId: input.toolCallId,
      toolId: input.toolId,
      input: input.input,
      status: "executed",
      output: toJsonValue(result.output),
      classification: await this.classifyToolResult(input.actor, input.toolId, result.output),
      sourceIds: input.sourceIds,
    };
  }

  private async classifyToolResult(
    actor: Actor,
    toolId: string,
    value: unknown,
  ): Promise<DataClassification> {
    const output = toJsonValue(value);
    return (
      this.options.classifyToolResult?.({ actor, toolId, output }) ??
      classificationFromToolResult(output)
    );
  }

  private async rememberTurn(
    actor: Actor,
    conversation: AssistantConversation,
    userContent: string,
    assistantContent: string,
    classification: DataClassification,
  ): Promise<void> {
    if (this.options.memory === undefined || !conversation.memoryOptIn) {
      return;
    }
    await this.options.memory.store(actor, {
      source: "assistant.conversation",
      content: `User: ${userContent}\nAssistant: ${assistantContent}`,
      metadata: { conversationId: conversation.id, classification },
    });
  }
}

function toolActivity(result: AssistantToolCallResult): AssistantToolActivity {
  return {
    toolCallId: result.toolCallId,
    toolId: result.toolId,
    status: result.status,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}
