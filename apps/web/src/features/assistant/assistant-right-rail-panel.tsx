import { Bot } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  assistantPendingActions,
  type AssistantPendingAction,
  type AssistantPendingMessage,
} from "@/features/assistant/pending-actions";
import { applyAssistantToolDecision, type ToolStatus } from "@/features/assistant/tool-decisions";
import { ToolCallCard } from "./assistant-tool-card";

const fallbackConversationId = "planning";

const fallbackPendingMessages: readonly AssistantPendingMessage[] = [
  {
    toolCalls: [
      {
        id: "tool-calendar",
        pendingId: "00000000-0000-4000-8000-000000000901",
        name: "Read release calendar",
        description:
          "Check the release calendar for owner reminder dates before drafting messages.",
        risk: "Reads calendar metadata only",
        status: "pending",
      },
    ],
  },
];

export function AssistantRightRailPanel({
  onToolDecision,
  pendingActions,
}: {
  readonly onToolDecision?: (toolId: string, decision: "confirm" | "cancel") => void;
  readonly pendingActions?: readonly AssistantPendingAction[];
} = {}) {
  const [railToolStatuses, setRailToolStatuses] = useState<Readonly<Record<string, ToolStatus>>>(
    {},
  );
  const [railToolErrors, setRailToolErrors] = useState<
    Readonly<Record<string, string | undefined>>
  >({});
  const fallbackPendingActions = useMemo(
    () =>
      assistantPendingActions({
        conversationId: fallbackConversationId,
        messages: fallbackPendingMessages,
        toolErrors: railToolErrors,
        toolStatuses: railToolStatuses,
      }),
    [railToolErrors, railToolStatuses],
  );
  const actions = pendingActions ?? fallbackPendingActions;
  const decideRailAction = useCallback(
    (action: AssistantPendingAction, decision: "confirm" | "cancel") => {
      if (onToolDecision !== undefined) {
        onToolDecision(action.toolCall.id, decision);
        return;
      }

      void applyAssistantToolDecision({
        conversationId: action.conversationId,
        decision,
        pendingId: action.toolCall.pendingId,
        setToolError: (toolId, message) =>
          setRailToolErrors((current) => ({ ...current, [toolId]: message })),
        setToolStatus: (toolId, status) =>
          setRailToolStatuses((current) => ({ ...current, [toolId]: status })),
        toolCallId: action.toolCall.id,
      }).catch(() => undefined);
    },
    [onToolDecision],
  );

  return (
    <section className="assistant-rail-panel" aria-label="Assistant panel">
      <header>
        <span>
          <Bot aria-hidden="true" size={18} />
        </span>
        <div>
          <h2>Assistant</h2>
          <p>Context and approvals</p>
        </div>
      </header>
      <div className="assistant-rail-card">
        <strong>Active context</strong>
        <p>
          Current route, selected workspace resources, and recent assistant sources are available
          for prompts.
        </p>
      </div>
      {actions.length > 0 ? (
        <div className="assistant-tool-list" aria-label="Pending assistant actions">
          {actions.map((action) => (
            <ToolCallCard
              error={action.error}
              key={`${action.conversationId}:${action.toolCall.id}`}
              onDecision={(_, decision) => decideRailAction(action, decision)}
              status={action.status}
              toolCall={action.toolCall}
            />
          ))}
        </div>
      ) : (
        <div className="assistant-rail-card">
          <strong>Pending action</strong>
          <p>No assistant actions are waiting for approval.</p>
        </div>
      )}
      <Link className="assistant-rail-link" to="/assistant">
        Open Assistant
      </Link>
    </section>
  );
}
