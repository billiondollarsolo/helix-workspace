import { Check, CircleAlert, Clock3, Wrench, X } from "lucide-react";
import type { AssistantPendingToolCall } from "@/features/assistant/pending-actions";
import type { ToolStatus } from "@/features/assistant/tool-decisions";

export function ToolCallCard({
  error,
  onDecision,
  status,
  toolCall,
}: {
  readonly error?: string;
  readonly onDecision: (toolId: string, decision: "confirm" | "cancel") => void;
  readonly status: ToolStatus;
  readonly toolCall: AssistantPendingToolCall;
}) {
  const isPending = status === "pending";

  return (
    <div className="assistant-tool-card" aria-label={toolCall.name} data-status={status}>
      <header>
        <Wrench aria-hidden="true" size={15} />
        <strong>{toolCall.name}</strong>
        <span className="assistant-tool-status" data-status={status}>
          {status === "pending" ? (
            <Clock3 aria-hidden="true" size={13} />
          ) : (
            <Check aria-hidden="true" size={13} />
          )}
          {status}
        </span>
      </header>
      <p className="assistant-tool-description">{toolCall.description}</p>
      <p className="assistant-tool-risk">
        <CircleAlert aria-hidden="true" size={13} />
        {toolCall.risk}
      </p>
      {error ? (
        <p className="assistant-tool-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="assistant-tool-actions">
        <button
          className="assistant-tool-button"
          disabled={!isPending}
          onClick={() => onDecision(toolCall.id, "cancel")}
          type="button"
        >
          <X aria-hidden="true" size={15} />
          Cancel
        </button>
        <button
          className="assistant-tool-button assistant-tool-button-primary"
          disabled={!isPending}
          onClick={() => onDecision(toolCall.id, "confirm")}
          type="button"
        >
          <Check aria-hidden="true" size={15} />
          Confirm
        </button>
      </div>
    </div>
  );
}
