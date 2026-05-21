import {
  decideAssistantToolCall,
  type AssistantToolDecision,
  type AssistantToolDecisionResult,
} from "./api";

export type ToolStatus = "pending" | "confirmed" | "cancelled" | "running";

export interface ApplyAssistantToolDecisionInput {
  readonly conversationId: string;
  readonly pendingId?: string;
  readonly toolCallId: string;
  readonly decision: AssistantToolDecision;
  readonly decideToolCall?: typeof decideAssistantToolCall;
  readonly setToolError: (toolCallId: string, message: string | undefined) => void;
  readonly setToolStatus: (toolCallId: string, status: ToolStatus) => void;
}

export async function applyAssistantToolDecision({
  conversationId,
  decision,
  decideToolCall = decideAssistantToolCall,
  setToolError,
  setToolStatus,
  pendingId,
  toolCallId,
}: ApplyAssistantToolDecisionInput): Promise<AssistantToolDecisionResult> {
  setToolError(toolCallId, undefined);
  setToolStatus(toolCallId, "running");

  try {
    const result = await decideToolCall({
      conversationId,
      pendingId: pendingId ?? toolCallId,
      decision,
    });
    setToolStatus(toolCallId, result.status);
    return result;
  } catch (error) {
    setToolStatus(toolCallId, "pending");
    setToolError(
      toolCallId,
      error instanceof Error ? error.message : "Assistant tool decision failed.",
    );
    throw error;
  }
}
