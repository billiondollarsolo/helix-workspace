import { authenticatedFetch } from "@/lib/auth";

export type AssistantToolDecision = "confirm" | "cancel";
export type AssistantToolDecisionStatus = "confirmed" | "cancelled";

export interface AssistantToolDecisionInput {
  readonly conversationId: string;
  readonly pendingId: string;
  readonly decision: AssistantToolDecision;
}

export interface AssistantToolDecisionResult {
  readonly status: AssistantToolDecisionStatus;
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
  readonly pending?: AssistantTurnPendingConfirmation;
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
  readonly sources?: readonly {
    readonly id: string;
    readonly type: string;
    readonly title?: string;
    readonly url?: string;
  }[];
  readonly toolCalls?: readonly AssistantTurnToolCall[];
  readonly pendingConfirmations?: readonly AssistantTurnPendingConfirmation[];
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
    }),
  });
  const output: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      errorMessageFromOutput(output) ??
        `Assistant tool ${input.decision} failed with ${String(response.status)}`,
    );
  }

  return {
    status: statusFromOutput(output) ?? statusFromDecision(input.decision),
  };
}

export async function sendAssistantChat(
  input: {
    readonly conversationId?: string;
    readonly message: string;
    readonly memoryOptIn?: boolean;
  },
  fetchImpl: AssistantToolDecisionFetch = authenticatedFetch,
): Promise<AssistantTurnResponseWithPendingConfirmations> {
  const response = await fetchImpl("/api/tools/assistant.chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: input.message,
      ...(isAssistantBackendConversationId(input.conversationId)
        ? { conversationId: input.conversationId }
        : {}),
      ...(input.memoryOptIn === undefined ? {} : { memoryOptIn: input.memoryOptIn }),
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
}

/**
 * Sends an assistant chat message and reports the response incrementally.
 *
 * When the backend responds with `text/event-stream` the body is parsed as
 * Server-Sent Events and each `delta` event is forwarded to `onDelta` as it
 * arrives. When the backend responds with plain JSON (today's tool endpoint)
 * the final text is revealed progressively so the UI still renders
 * incrementally. Either way the resolved value is the complete turn.
 */
export async function streamAssistantChat(
  input: {
    readonly conversationId?: string;
    readonly message: string;
    readonly memoryOptIn?: boolean;
  },
  callbacks: AssistantChatStreamCallbacks,
  fetchImpl: AssistantToolDecisionFetch = authenticatedFetch,
): Promise<AssistantTurnResponseWithPendingConfirmations> {
  const response = await fetchImpl("/api/tools/assistant.chat", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({
      message: input.message,
      ...(isAssistantBackendConversationId(input.conversationId)
        ? { conversationId: input.conversationId }
        : {}),
      ...(input.memoryOptIn === undefined ? {} : { memoryOptIn: input.memoryOptIn }),
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

  const turn = output as AssistantTurnResponseWithPendingConfirmations;
  revealAssistantResponse(turn.response?.content ?? "", callbacks.onDelta);
  return turn;
}

/** Parses an assistant SSE body, forwarding `delta` text and resolving the final turn. */
async function consumeAssistantSseStream(
  body: ReadableStream<Uint8Array>,
  callbacks: AssistantChatStreamCallbacks,
): Promise<AssistantTurnResponseWithPendingConfirmations> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalTurn: AssistantTurnResponseWithPendingConfirmations = {};
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        finalTurn = applyAssistantSseFrame(frame, callbacks, finalTurn);
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      finalTurn = applyAssistantSseFrame(buffer, callbacks, finalTurn);
    }
  } finally {
    reader.releaseLock();
  }
  return finalTurn;
}

function applyAssistantSseFrame(
  frame: string,
  callbacks: AssistantChatStreamCallbacks,
  finalTurn: AssistantTurnResponseWithPendingConfirmations,
): AssistantTurnResponseWithPendingConfirmations {
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
  if (parsed.type === "delta" && typeof parsed.text === "string") {
    callbacks.onDelta(parsed.text);
    return finalTurn;
  }
  if (parsed.type === "final" && isRecord(parsed.turn)) {
    return parsed.turn;
  }
  return finalTurn;
}

/**
 * Reveals a non-streamed response through the incremental `onDelta` callback.
 * Used when the backend returns plain JSON rather than an SSE stream so the UI
 * still renders the assistant turn via the streaming code path.
 */
function revealAssistantResponse(text: string, onDelta: (text: string) => void): void {
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    onDelta(trimmed);
  }
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

function statusFromOutput(output: unknown): AssistantToolDecisionStatus | undefined {
  if (!isRecord(output)) {
    return undefined;
  }
  return output.status === "confirmed" || output.status === "cancelled" ? output.status : undefined;
}

function errorMessageFromOutput(output: unknown): string | undefined {
  return isRecord(output) && typeof output.error === "string" ? output.error : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
