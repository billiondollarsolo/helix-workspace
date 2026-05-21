import type {
  Actor,
  AIClassification,
  ChatResponse,
  JsonObject,
  JsonValue,
  PendingToolInvocation,
  RequestContext,
  ToolDefinition,
} from "@helix/sdk-types";
import type { ForgetCriteria, MemoryItem } from "../ai/memory/index.js";
import type { SearchHit } from "../search/index.js";

export type AssistantMessageRole = "system" | "user" | "assistant" | "tool";

export interface AssistantConversation {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly title: string | null;
  readonly memoryOptIn: boolean;
  readonly metadata: JsonObject;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AssistantMessage {
  readonly id: string;
  readonly orgId: string;
  readonly conversationId: string;
  readonly actorId: string | null;
  readonly role: AssistantMessageRole;
  readonly content: string;
  readonly toolCallId: string | null;
  readonly metadata: JsonObject;
  readonly createdAt: string;
}

export interface AssistantMemoryPreference {
  readonly orgId: string;
  readonly actorId: string;
  readonly enabled: boolean;
  readonly metadata: JsonObject;
  readonly updatedAt: string;
}

export interface AssistantCreateConversationInput {
  readonly actor: Actor;
  readonly title?: string;
  readonly memoryOptIn?: boolean;
  readonly metadata?: JsonObject;
}

export interface AssistantAppendMessageInput {
  readonly conversationId: string;
  readonly orgId: string;
  readonly actorId?: string | null;
  readonly role: AssistantMessageRole;
  readonly content: string;
  readonly toolCallId?: string | null;
  readonly metadata?: JsonObject;
  readonly createdAt?: Date;
}

export interface AssistantStore {
  createConversation(input: AssistantCreateConversationInput): Promise<AssistantConversation>;
  getConversation(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly conversationId: string;
  }): Promise<AssistantConversation | null>;
  listMessages(input: {
    readonly orgId: string;
    readonly conversationId: string;
    readonly limit?: number;
  }): Promise<readonly AssistantMessage[]>;
  appendMessage(input: AssistantAppendMessageInput): Promise<AssistantMessage>;
  setConversationMemoryOptIn(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly conversationId: string;
    readonly enabled: boolean;
  }): Promise<AssistantConversation | null>;
  getMemoryPreference(actor: Actor): Promise<AssistantMemoryPreference | null>;
  setMemoryPreference(input: {
    readonly actor: Actor;
    readonly enabled: boolean;
    readonly metadata?: JsonObject;
  }): Promise<AssistantMemoryPreference>;
}

export interface AssistantSource {
  readonly id: string;
  readonly type: string;
  readonly title?: string;
  readonly body?: string;
  readonly url?: string;
  readonly score?: number;
  readonly attributes?: JsonObject;
}

export type AssistantToolCallStatus = "executed" | "pending_confirmation" | "failed" | "skipped";

export interface AssistantToolCallResult {
  readonly toolCallId: string;
  readonly toolId: string;
  readonly input: JsonObject;
  readonly status: AssistantToolCallStatus;
  readonly output?: JsonValue;
  readonly pending?: PendingToolInvocation;
  readonly error?: string;
}

export interface AssistantTurnResponse {
  readonly conversation: AssistantConversation;
  readonly messages: readonly AssistantMessage[];
  readonly response: AssistantMessage;
  readonly ai: ChatResponse;
  readonly toolCalls: readonly AssistantToolCallResult[];
  readonly sources: readonly AssistantSource[];
  readonly memory: readonly MemoryItem[];
  readonly pendingConfirmations: readonly PendingToolInvocation[];
}

/**
 * Incremental event emitted while {@link AssistantOrchestrator.sendMessageStream}
 * runs. `delta` events carry partial assistant text; the terminal `final`
 * event carries the full {@link AssistantTurnResponse}.
 */
export type AssistantStreamEvent =
  | {
      readonly type: "delta";
      readonly text: string;
      readonly round: number;
    }
  | {
      readonly type: "final";
      readonly turn: AssistantTurnResponse;
    };

export interface AssistantSendMessageInput {
  readonly actor: Actor;
  readonly content: string;
  readonly conversationId?: string;
  readonly title?: string;
  readonly memoryOptIn?: boolean;
  readonly classification?: AIClassification;
  readonly request?: RequestContext;
  readonly metadata?: JsonObject;
}

export interface AssistantApprovePendingToolInput {
  readonly actor: Actor;
  readonly conversationId: string;
  readonly pendingId: string;
  readonly classification?: AIClassification;
  readonly request?: RequestContext;
  readonly metadata?: JsonObject;
}

export interface AssistantCancelPendingToolInput {
  readonly actor: Actor;
  readonly conversationId: string;
  readonly pendingId: string;
  readonly classification?: AIClassification;
  readonly request?: RequestContext;
  readonly metadata?: JsonObject;
}

export interface AssistantForgetMemoryInput {
  readonly actor: Actor;
  readonly conversationId?: string;
  readonly criteria?: ForgetCriteria;
  readonly disableMemory?: boolean;
  readonly request?: RequestContext;
}

export interface AssistantForgetMemoryResult {
  readonly forgottenCount: number;
  readonly conversation?: AssistantConversation;
  readonly preference?: AssistantMemoryPreference;
}

export interface AssistantVisibleTool {
  readonly id: string;
  readonly description: string;
  readonly permission: string;
  readonly sideEffects: ToolDefinition["sideEffects"];
  readonly confirmationRequired: boolean;
  readonly inputSchema: JsonObject;
}

export function searchHitToAssistantSource(hit: SearchHit): AssistantSource {
  return {
    id: hit.id,
    type: hit.type,
    ...(hit.title === undefined ? {} : { title: hit.title }),
    ...(hit.body === undefined ? {} : { body: hit.body }),
    ...(hit.url === undefined ? {} : { url: hit.url }),
    ...(hit.score === undefined ? {} : { score: hit.score }),
    ...(hit.attributes === undefined ? {} : { attributes: hit.attributes }),
  };
}
