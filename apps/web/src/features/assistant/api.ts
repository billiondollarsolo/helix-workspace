import { authenticatedFetch } from "@/lib/auth";
import { callTool } from "@/lib/tool-call";

export type AssistantToolDecision = "confirm" | "cancel";
type AssistantToolDecisionStatus = "confirmed" | "cancelled" | "failed";

export interface AssistantToolDecisionInput {
  readonly conversationId: string;
  readonly pendingId: string;
  readonly decision: AssistantToolDecision;
  readonly metadata?: Record<string, unknown>;
}

export interface AssistantToolDecisionResult {
  readonly status: AssistantToolDecisionStatus;
  readonly turn?: AssistantTurnResponseWithPendingConfirmations;
  readonly error?: string;
}

export interface AssistantMemoryForgetResult {
  readonly forgottenCount?: number;
  readonly conversation?: {
    readonly id?: string;
  };
  readonly preference?: {
    readonly enabled?: boolean;
  };
}

export interface AssistantTurnPendingConfirmation {
  readonly id: string;
  readonly toolId: string;
}

export interface AssistantTurnToolCall {
  readonly toolCallId: string;
  readonly toolId: string;
  readonly input?: Record<string, unknown>;
  readonly status?: string;
  readonly error?: string;
  readonly pending?: AssistantTurnPendingConfirmation;
}

export interface AssistantAttachment {
  readonly objectId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
}

export interface AssistantToolActivity {
  readonly toolCallId: string;
  readonly toolId: string;
  readonly status: "running" | "executed" | "failed" | "skipped" | "pending_confirmation";
  readonly error?: string;
}
export interface AssistantSource {
  readonly id: string;
  readonly type: string;
  readonly title?: string;
  readonly url?: string;
}
export interface AssistantToolGroups {
  readonly groups: readonly {
    readonly id: string;
    readonly label: string;
    readonly count: number;
    readonly defaultEnabled: boolean;
  }[];
}
export function listAssistantTools(): Promise<AssistantToolGroups> {
  return callAssistantTool<AssistantToolGroups>("assistant.tools.list", {});
}

export interface AssistantChatInput {
  readonly conversationId?: string;
  readonly editMessageId?: string;
  readonly webSearch?: boolean;
  readonly toolGroups?: readonly string[];
  readonly message: string;
  readonly memoryOptIn?: boolean;
  readonly modelId?: string;
  readonly attachmentObjectIds?: readonly string[];
}

export interface AssistantModels {
  readonly webSearchEnabled?: boolean;
  readonly models: readonly {
    readonly id: string;
    readonly label: string;
    readonly providerId: string;
    readonly model: string;
  }[];
  readonly defaultModelId?: string;
}

export function listAssistantModels(): Promise<AssistantModels> {
  return callAssistantTool<AssistantModels>("assistant.models.list", {}).then((output) => ({
    ...output,
    models: Array.isArray(output.models) ? output.models : [],
  }));
}

export function getAssistantConversation(
  conversationId: string,
): Promise<AssistantTurnResponseWithPendingConfirmations> {
  return callAssistantTool<AssistantTurnResponseWithPendingConfirmations>(
    "assistant.conversation.get",
    { conversationId },
  );
}

export interface AssistantTurnResponseWithPendingConfirmations {
  readonly conversation?: {
    readonly id?: string;
  };
  readonly response?: {
    readonly id?: string;
    readonly content?: string;
    readonly createdAt?: string;
  };
  readonly ai?: {
    readonly providerId?: string;
    readonly model?: string;
    readonly usage?: {
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly totalTokens?: number;
      readonly costCents?: number;
    };
    readonly metadata?: Record<string, unknown>;
  };
  readonly sources?: readonly AssistantSource[];
  readonly toolCalls?: readonly AssistantTurnToolCall[];
  readonly pendingConfirmations?: readonly AssistantTurnPendingConfirmation[];
  /** Full persisted conversation history after the turn (newest last). */
  readonly messages?: readonly {
    readonly id: string;
    readonly conversationId?: string;
    readonly role: "system" | "user" | "assistant" | "tool";
    readonly content: string;
    readonly attachments?: readonly AssistantAttachment[];
    readonly sources?: readonly AssistantSource[];
    readonly toolActivity?: readonly AssistantToolActivity[];
    readonly toolGroups?: readonly string[];
    readonly webSearch?: boolean;
    readonly createdAt?: string;
  }[];
}

export type AssistantToolDecisionFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function decideAssistantToolCall(
  input: AssistantToolDecisionInput,
  fetchImpl: AssistantToolDecisionFetch = authenticatedFetch,
): Promise<AssistantToolDecisionResult> {
  const response = await fetchImpl(assistantToolDecisionUrl(input), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      conversationId: input.conversationId,
      pendingId: input.pendingId,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    }),
  });
  const output: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      errorMessageFromOutput(output) ??
        `Assistant tool ${input.decision} failed with ${String(response.status)}`,
    );
  }

  if (
    !isRecord(output) ||
    !isRecord(output.conversation) ||
    typeof output.conversation.id !== "string" ||
    !isRecord(output.response) ||
    typeof output.response.content !== "string" ||
    !Array.isArray(output.messages)
  ) {
    throw new Error(
      "Could not read the action result. Reopen the conversation to check its outcome.",
    );
  }
  const turn = output as AssistantTurnResponseWithPendingConfirmations;
  const failed = turn.toolCalls?.find((call) => call.status === "failed");
  return {
    status: failed === undefined ? statusFromDecision(input.decision) : "failed",
    turn,
    ...(failed === undefined ? {} : { error: failed.error ?? "The approved action failed." }),
  };
}

export async function sendAssistantChat(
  input: AssistantChatInput,
  fetchImpl: AssistantToolDecisionFetch = authenticatedFetch,
): Promise<AssistantTurnResponseWithPendingConfirmations> {
  const response = await fetchImpl("/api/tools/assistant.chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: input.message,
      metadata: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      ...(isAssistantBackendConversationId(input.conversationId)
        ? { conversationId: input.conversationId }
        : {}),
      ...(input.memoryOptIn === undefined ? {} : { memoryOptIn: input.memoryOptIn }),
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      ...(input.editMessageId === undefined ? {} : { editMessageId: input.editMessageId }),
      ...(input.webSearch === undefined ? {} : { webSearch: input.webSearch }),
      ...(input.toolGroups === undefined ? {} : { toolGroups: input.toolGroups }),
      ...(input.attachmentObjectIds === undefined
        ? {}
        : { attachmentObjectIds: input.attachmentObjectIds }),
    }),
  });
  const output: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      errorMessageFromOutput(output) ?? `Assistant chat failed with ${String(response.status)}`,
    );
  }

  return output as AssistantTurnResponseWithPendingConfirmations;
}

export interface AssistantChatStreamCallbacks {
  /** Invoked for each incremental text fragment as it arrives. */
  readonly onDelta: (text: string) => void;
  readonly onTool?: (activity: AssistantToolActivity) => void;
  readonly signal?: AbortSignal;
}

/** Streams real deltas; JSON responses are returned as a single complete turn. */
export async function streamAssistantChat(
  input: AssistantChatInput,
  callbacks: AssistantChatStreamCallbacks,
  fetchImpl: AssistantToolDecisionFetch = authenticatedFetch,
): Promise<AssistantTurnResponseWithPendingConfirmations> {
  const response = await fetchImpl("/api/tools/assistant.chat", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    ...(callbacks.signal === undefined ? {} : { signal: callbacks.signal }),
    body: JSON.stringify({
      message: input.message,
      metadata: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      ...(isAssistantBackendConversationId(input.conversationId)
        ? { conversationId: input.conversationId }
        : {}),
      ...(input.memoryOptIn === undefined ? {} : { memoryOptIn: input.memoryOptIn }),
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      ...(input.editMessageId === undefined ? {} : { editMessageId: input.editMessageId }),
      ...(input.webSearch === undefined ? {} : { webSearch: input.webSearch }),
      ...(input.toolGroups === undefined ? {} : { toolGroups: input.toolGroups }),
      ...(input.attachmentObjectIds === undefined
        ? {}
        : { attachmentObjectIds: input.attachmentObjectIds }),
    }),
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (response.ok && contentType.includes("text/event-stream") && response.body !== null) {
    return consumeAssistantSseStream(response.body, callbacks);
  }

  const output: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      errorMessageFromOutput(output) ?? `Assistant chat failed with ${String(response.status)}`,
    );
  }

  return output as AssistantTurnResponseWithPendingConfirmations;
}

/** Parses an assistant SSE body, forwarding `delta` text and resolving the final turn. */
async function consumeAssistantSseStream(
  body: ReadableStream<Uint8Array>,
  callbacks: AssistantChatStreamCallbacks,
): Promise<AssistantTurnResponseWithPendingConfirmations> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalTurn: AssistantTurnResponseWithPendingConfirmations | undefined;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  callbacks.signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      callbacks.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      callbacks.signal?.throwIfAborted();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = /\r?\n\r?\n/u.exec(buffer);
      while (boundary !== null) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        finalTurn = applyAssistantSseFrame(frame, callbacks, finalTurn);
        boundary = /\r?\n\r?\n/u.exec(buffer);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      finalTurn = applyAssistantSseFrame(buffer, callbacks, finalTurn);
    }
  } finally {
    callbacks.signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (finalTurn === undefined)
    throw new Error("The response was interrupted. Try sending your message again.");
  return finalTurn;
}

function applyAssistantSseFrame(
  frame: string,
  callbacks: AssistantChatStreamCallbacks,
  finalTurn: AssistantTurnResponseWithPendingConfirmations | undefined,
): AssistantTurnResponseWithPendingConfirmations | undefined {
  const dataLines = frame
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => (line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5)));
  if (dataLines.length === 0) {
    return finalTurn;
  }
  const data = dataLines.join("\n");
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return finalTurn;
  }
  if (!isRecord(parsed)) {
    return finalTurn;
  }
  if (parsed.type === "error")
    throw new Error(errorMessageFromOutput(parsed) ?? "The response failed. Try again.");
  if (parsed.type === "delta" && typeof parsed.text === "string") {
    callbacks.onDelta(parsed.text);
    return finalTurn;
  }
  if (
    parsed.type === "tool" &&
    typeof parsed.toolCallId === "string" &&
    typeof parsed.toolId === "string" &&
    typeof parsed.status === "string" &&
    ["running", "executed", "failed", "skipped", "pending_confirmation"].includes(parsed.status)
  ) {
    callbacks.onTool?.({
      toolCallId: parsed.toolCallId,
      toolId: parsed.toolId,
      status: parsed.status as AssistantToolActivity["status"],
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
    });
    return finalTurn;
  }
  if (parsed.type === "final" && isRecord(parsed.turn)) {
    return parsed.turn;
  }
  return finalTurn;
}

export async function forgetAssistantMemory(
  input: {
    readonly conversationId?: string;
  } = {},
  fetchImpl: AssistantToolDecisionFetch = authenticatedFetch,
): Promise<AssistantMemoryForgetResult> {
  const response = await fetchImpl("/api/tools/assistant.memory.forget", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(isAssistantBackendConversationId(input.conversationId)
        ? { conversationId: input.conversationId }
        : {}),
    }),
  });
  const output: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      errorMessageFromOutput(output) ??
        `Assistant memory forget failed with ${String(response.status)}`,
    );
  }

  return output as AssistantMemoryForgetResult;
}

/* ----------------------------------------------------- conversation list -- */

/** A conversation projected for the 240px Assistant thread list. */
export interface AssistantConversationListItem {
  readonly id: string;
  readonly title: string | null;
  readonly pinned: boolean;
  readonly pinnedAt: string | null;
  readonly memoryOptIn: boolean;
  readonly updatedAt: string;
  readonly createdAt: string;
  readonly messageCount: number;
  readonly preview: string | null;
}

export interface AssistantConversationListPage {
  readonly items: readonly AssistantConversationListItem[];
  readonly nextCursor: string | null;
}

export interface AssistantConversationListInput {
  readonly query?: string;
  readonly pinnedOnly?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

/** A persisted conversation as returned by pin/unpin/rename tools. */
export interface AssistantConversationRecord {
  readonly id: string;
  readonly title: string | null;
  readonly pinnedAt: string | null;
  readonly memoryOptIn: boolean;
  readonly updatedAt: string;
  readonly createdAt: string;
}

/**
 * Lists the current actor's assistant conversations for the thread list.
 * Pinned-first, with optional `query` search and keyset pagination via `cursor`.
 */
export async function listAssistantConversations(
  input: AssistantConversationListInput = {},
  fetchImpl: AssistantToolDecisionFetch = authenticatedFetch,
): Promise<AssistantConversationListPage> {
  const trimmedQuery = input.query?.trim() ?? "";
  const output = await callAssistantTool<Partial<AssistantConversationListPage>>(
    "assistant.conversations.list",
    {
      ...(trimmedQuery.length === 0 ? {} : { query: trimmedQuery }),
      ...(input.pinnedOnly === undefined ? {} : { pinnedOnly: input.pinnedOnly }),
      limit: input.limit ?? 50,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    },
    fetchImpl,
  );
  return {
    items: output.items ?? [],
    nextCursor: output.nextCursor ?? null,
  };
}

/** Pins (`pinned: true`) or unpins a conversation in the thread list. */
export async function setAssistantConversationPinned(
  input: { readonly conversationId: string; readonly pinned: boolean },
  fetchImpl: AssistantToolDecisionFetch = authenticatedFetch,
): Promise<AssistantConversationRecord> {
  return callAssistantTool<AssistantConversationRecord>(
    input.pinned ? "assistant.conversation.pin" : "assistant.conversation.unpin",
    { conversationId: input.conversationId },
    fetchImpl,
  );
}

/** Renames a conversation. */
export async function renameAssistantConversation(
  input: { readonly conversationId: string; readonly title: string },
  fetchImpl: AssistantToolDecisionFetch = authenticatedFetch,
): Promise<AssistantConversationRecord> {
  return callAssistantTool<AssistantConversationRecord>(
    "assistant.conversation.rename",
    { conversationId: input.conversationId, title: input.title.trim() },
    fetchImpl,
  );
}

/** Deletes (archives) a conversation, removing it from the thread list. */
export async function deleteAssistantConversation(
  input: { readonly conversationId: string },
  fetchImpl: AssistantToolDecisionFetch = authenticatedFetch,
): Promise<void> {
  await callAssistantTool<unknown>(
    "assistant.conversation.delete",
    { conversationId: input.conversationId },
    fetchImpl,
  );
}

/** Invokes a tool-registry endpoint and unwraps a JSON or error envelope. */
async function callAssistantTool<Output>(
  toolId: string,
  input: unknown,
  fetchImpl: AssistantToolDecisionFetch = authenticatedFetch,
): Promise<Output> {
  // Note: most assistant confirmation flows are handled explicitly through
  // assistant.confirmation.approve/cancel (the assistant tool-decision UI),
  // not via tool-level pending_confirmation. But for general tool deletes
  // / writes the shared callTool helper auto-approves.
  return callTool<Output>(toolId, input, { fetchImpl });
}

export function assistantToolDecisionUrl(input: AssistantToolDecisionInput): string {
  return input.decision === "confirm"
    ? "/api/tools/assistant.confirmation.approve"
    : "/api/tools/assistant.confirmation.cancel";
}

export function assistantToolPendingId(
  turn: AssistantTurnResponseWithPendingConfirmations,
  toolCall: AssistantTurnToolCall,
): string | undefined {
  if (toolCall.pending?.id !== undefined) {
    return toolCall.pending.id;
  }

  return turn.pendingConfirmations?.find((pending) => pending.toolId === toolCall.toolId)?.id;
}

export function isAssistantBackendConversationId(value: string | undefined): value is string {
  return (
    value !== undefined &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function statusFromDecision(decision: AssistantToolDecision): AssistantToolDecisionStatus {
  return decision === "confirm" ? "confirmed" : "cancelled";
}

function errorMessageFromOutput(output: unknown): string | undefined {
  if (!isRecord(output)) {
    return undefined;
  }
  if (typeof output.error === "string") {
    return output.error;
  }
  // HelixError envelope: { error: { code, message, traceId } }.
  if (isRecord(output.error) && typeof output.error.message === "string") {
    return output.error.message;
  }
  if (typeof output.message === "string") {
    return output.message;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
