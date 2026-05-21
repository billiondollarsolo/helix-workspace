import type { ToolStatus } from "@/features/assistant/tool-decisions";

export interface AssistantPendingToolCall {
  readonly id: string;
  readonly pendingId?: string;
  readonly name: string;
  readonly description: string;
  readonly risk: string;
  readonly status: ToolStatus;
}

export interface AssistantPendingAction {
  readonly conversationId: string;
  readonly toolCall: AssistantPendingToolCall;
  readonly status: ToolStatus;
  readonly error?: string;
}

export interface AssistantPendingMessage {
  readonly toolCalls?: readonly AssistantPendingToolCall[];
}

export function assistantPendingActions({
  conversationId,
  messages,
  toolErrors = {},
  toolStatuses = {},
}: {
  readonly conversationId: string;
  readonly messages: readonly AssistantPendingMessage[];
  readonly toolErrors?: Readonly<Record<string, string | undefined>>;
  readonly toolStatuses?: Readonly<Record<string, ToolStatus>>;
}): readonly AssistantPendingAction[] {
  return messages.flatMap((message) =>
    (message.toolCalls ?? [])
      .map((toolCall) => {
        const status = toolStatuses[toolCall.id] ?? toolCall.status;
        return {
          conversationId,
          error: toolErrors[toolCall.id],
          status,
          toolCall,
        };
      })
      .filter((action) => action.status === "pending" || action.status === "running"),
  );
}
