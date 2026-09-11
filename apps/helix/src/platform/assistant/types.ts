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
import type { ToolInvocationPrincipal } from "../auth/tool-invocation-principal.js";

type AssistantMessageRole = "system" | "user" | "assistant" | "tool";

export interface AssistantConversation {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly title: string | null;
  readonly memoryOptIn: boolean;
  /** ISO timestamp the conversation was pinned, or null when not pinned. */
  readonly pinnedAt: string | null;
  readonly metadata: JsonObject;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A conversation projected for the Assistant UI thread list: identity, pin
 * state, last-activity timestamp, and a preview derived from the latest message.
 */
export interface AssistantConversationListItem {
  readonly id: string;
  readonly title: string | null;
  readonly pinned: boolean;
  readonly pinnedAt: string | null;
  readonly memoryOptIn: boolean;
  /** Last-activity timestamp (most recent message or the conversation itself). */
  readonly updatedAt: string;
  readonly createdAt: string;
  readonly messageCount: number;
  /** Truncated text of the most recent message, or null for an empty conversation. */
  readonly preview: string | null;
}

export interface AssistantListConversationsInput {
  readonly orgId: string;
  readonly actorId: string;
  /** Case-insensitive substring matched against the title and last message. */
  readonly query?: string;
  /** When true, return only pinned conversations. */
  readonly pinnedOnly?: boolean;
  readonly limit: number;
  /** Keyset cursor: exclude conversations at/before this `updatedAt` ISO timestamp. */
  readonly cursor?: string;
}

export interface AssistantConversationListPage {
  readonly items: readonly AssistantConversationListItem[];
  /** Cursor for the next page, or null when the last page has been returned. */
  readonly nextCursor: string | null;
}

interface AssistantAttachment {
  readonly objectId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
}

export interface AssistantLoadedAttachment {
  readonly attachment: AssistantAttachment;
  readonly source: AssistantSource;
}

export interface AssistantModelCatalog {
  readonly webSearchEnabled?: boolean;
  readonly models: readonly {
    readonly id: string;
    readonly label: string;
    readonly providerId: string;
    readonly model: string;
  }[];
  readonly defaultModelId?: string;
}

export interface AssistantMessage {
  readonly sources?: readonly AssistantSource[];
  readonly toolActivity?: readonly AssistantToolActivity[];
  readonly toolGroups?: readonly string[];
  readonly webSearch?: boolean;
  readonly id: string;
  readonly orgId: string;
  readonly conversationId: string;
  readonly actorId: string | null;
  readonly role: AssistantMessageRole;
  readonly content: string;
  readonly toolCallId: string | null;
  readonly attachments?: readonly AssistantAttachment[];
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

export interface AssistantPendingTurnContext {
  readonly pending: AssistantMessage;
  readonly origin: AssistantMessage;
  readonly assistant: AssistantMessage;
  readonly history: readonly AssistantMessage[];
}
export interface AssistantPendingTurnQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly conversationId: string;
  readonly pendingId: string;
  readonly limit: number;
}

export interface AssistantStore {
  getPendingTurnContext(
    input: AssistantPendingTurnQuery,
  ): Promise<AssistantPendingTurnContext | null>;
  createConversation(input: AssistantCreateConversationInput): Promise<AssistantConversation>;
  getConversation(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly conversationId: string;
  }): Promise<AssistantConversation | null>;
  /**
   * List the actor's non-archived conversations for the UI thread list, ordered
   * pinned-first then by recency, with optional search and keyset pagination.
   */
  listConversations(input: AssistantListConversationsInput): Promise<AssistantConversationListPage>;
  /** Pin (`pinned: true`) or unpin a conversation; returns null when not found. */
  setConversationPinned(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly conversationId: string;
    readonly pinned: boolean;
  }): Promise<AssistantConversation | null>;
  /** Rename a conversation; returns null when not found. */
  renameConversation(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly conversationId: string;
    readonly title: string;
  }): Promise<AssistantConversation | null>;
  /** Soft-delete (archive) a conversation; returns false when not found. */
  deleteConversation(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly conversationId: string;
  }): Promise<boolean>;
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
  patchConversationMetadata(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly conversationId: string;
    readonly metadata: JsonObject;
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
  readonly trust: "untrusted_retrieved";
  readonly classification: AIClassification;
  readonly provenance: {
    readonly sourceId: string;
    readonly sourceType: string;
    readonly orgId: string;
  };
  readonly title?: string;
  readonly url?: string;
  readonly body?: string;
  readonly score?: number;
  readonly media?: {
    readonly mimeType: string;
    readonly data: string;
  };
}

type AssistantToolCallStatus = "executed" | "pending_confirmation" | "failed" | "skipped";

export interface AssistantToolCallResult {
  readonly toolCallId: string;
  readonly toolId: string;
  readonly input: JsonObject;
  readonly status: AssistantToolCallStatus;
  readonly output?: JsonValue;
  /** Classification computed by the server after executing this tool. */
  readonly classification?: AIClassification;
  readonly pending?: PendingToolInvocation;
  readonly error?: string;
  readonly statusCode?: number;
  readonly retryAfterSeconds?: number;
  /** IDs only; source contents never enter generic tool audit/provenance. */
  readonly sourceIds?: readonly string[];
}

export type AssistantToolResultClassifier = (input: {
  readonly actor: Actor;
  readonly toolId: string;
  readonly output: JsonValue | undefined;
}) => Promise<AIClassification>;

export interface AssistantTurnResponse {
  readonly conversation: AssistantConversation;
  readonly messages: readonly AssistantMessage[];
  readonly response: AssistantMessage;
  readonly ai: ChatResponse;
  readonly toolCalls: readonly AssistantToolCallResult[];
  readonly sources: readonly AssistantSource[];
  readonly memory: readonly MemoryItem[];
  readonly pendingConfirmations: readonly PendingToolInvocation[];
  readonly effectiveClassification: AIClassification;
}

/**
 * Incremental event emitted while {@link AssistantOrchestrator.sendMessageStream}
 * runs. `delta` events carry partial assistant text; the terminal `final`
 * event carries the full {@link AssistantTurnResponse}.
 */
export type AssistantToolActivity = {
  readonly toolCallId: string;
  readonly toolId: string;
  readonly status: AssistantToolCallStatus | "running";
  readonly error?: string;
};

export type AssistantStreamEvent =
  | ({ readonly type: "tool" } & AssistantToolActivity)
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
  readonly toolGroups?: readonly string[];
  readonly webSearch?: boolean;
  readonly classification?: AIClassification;
  readonly signal?: AbortSignal;
  readonly modelId?: string;
  readonly attachmentObjectIds?: readonly string[];
  readonly actor: Actor;
  /** Server-internal invocation policy; never persisted in conversation data. */
  readonly principal?: ToolInvocationPrincipal;
  readonly content: string;
  readonly conversationId?: string;
  /** Branch this owned user message and regenerate using only its preceding history. */
  readonly editMessageId?: string;
  readonly title?: string;
  readonly memoryOptIn?: boolean;
  readonly request?: RequestContext;
  readonly metadata?: JsonObject;
}

export interface AssistantApprovePendingToolInput {
  readonly classification?: AIClassification;
  readonly actor: Actor;
  readonly principal?: ToolInvocationPrincipal;
  readonly conversationId: string;
  readonly pendingId: string;
  readonly request?: RequestContext;
  readonly metadata?: JsonObject;
}

export interface AssistantCancelPendingToolInput {
  readonly classification?: AIClassification;
  readonly actor: Actor;
  readonly principal?: ToolInvocationPrincipal;
  readonly conversationId: string;
  readonly pendingId: string;
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
