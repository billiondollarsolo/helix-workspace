/**
 * A12 — Pending tool-approval panel for Assistant.
 * Presentational + pure helpers; decisions go through applyAssistantToolDecision.
 */

import { useState } from "react";
import type { AssistantTurnPendingConfirmation, AssistantTurnToolCall } from "./api";
import type { ToolStatus } from "./tool-decisions";

export interface PendingApprovalItem extends AssistantTurnPendingConfirmation {
  readonly toolCallId?: string;
  readonly status?: ToolStatus;
  readonly error?: string;
  readonly input?: Record<string, unknown>;
}

export interface AskUserField {
  readonly id: string;
  readonly label: string;
  readonly type: "text" | "select" | "boolean";
  readonly options: readonly string[];
}

export function askUserFields(input: Record<string, unknown> | undefined): readonly AskUserField[] {
  if (input === undefined || !Array.isArray(input.fields)) return [];
  return input.fields.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const field = entry as Record<string, unknown>;
    if (typeof field.id !== "string" || typeof field.label !== "string") return [];
    const type = field.type === "select" || field.type === "boolean" ? field.type : "text";
    const options = Array.isArray(field.options)
      ? field.options.filter((value): value is string => typeof value === "string")
      : [];
    return [{ id: field.id, label: field.label, type, options }];
  });
}

export function pendingItemsFromTurn(turn: {
  readonly pendingConfirmations?: readonly AssistantTurnPendingConfirmation[];
  readonly toolCalls?: readonly AssistantTurnToolCall[];
}): PendingApprovalItem[] {
  const fromCalls: PendingApprovalItem[] = [];
  for (const call of turn.toolCalls ?? []) {
    if (call.pending === undefined) continue;
    fromCalls.push({
      id: call.pending.id,
      toolId: call.pending.toolId,
      toolCallId: call.toolCallId,
      status: "pending",
      ...(call.input === undefined ? {} : { input: call.input }),
    });
  }
  if (fromCalls.length > 0) return fromCalls;
  return (turn.pendingConfirmations ?? []).map((pending) => {
    const call = turn.toolCalls?.find((entry) => entry.toolId === pending.toolId);
    return {
      id: pending.id,
      toolId: pending.toolId,
      status: "pending" as const,
      ...(call?.toolCallId === undefined ? {} : { toolCallId: call.toolCallId }),
      ...(call?.input === undefined ? {} : { input: call.input }),
    };
  });
}

export function normalizePendingApprovals(
  items: readonly PendingApprovalItem[] | undefined | null,
): readonly PendingApprovalItem[] {
  if (items === undefined || items === null) {
    return [];
  }
  const seen = new Set<string>();
  const out: PendingApprovalItem[] = [];
  for (const item of items) {
    if (item.id.trim().length === 0 || item.toolId.trim().length === 0) {
      continue;
    }
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/** An approval still awaiting the user: unset, pending, or mid-run. */
function isActionablePendingApproval(item: PendingApprovalItem): boolean {
  return item.status === undefined || item.status === "pending" || item.status === "running";
}

export function pendingApprovalsVisible(
  items: readonly PendingApprovalItem[] | undefined | null,
): boolean {
  return normalizePendingApprovals(items).some(isActionablePendingApproval);
}

export interface PendingApprovalsPanelProps {
  readonly items: readonly PendingApprovalItem[];
  readonly busy?: boolean;
  readonly onConfirm: (item: PendingApprovalItem, metadata?: Record<string, unknown>) => void;
  readonly onCancel: (item: PendingApprovalItem) => void;
}

export function PendingApprovalsPanel({
  items,
  busy = false,
  onConfirm,
  onCancel,
}: PendingApprovalsPanelProps) {
  const visible = normalizePendingApprovals(items).filter(isActionablePendingApproval);
  const [answers, setAnswers] = useState<Record<string, Record<string, string>>>({});
  if (visible.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="Pending tool approvals"
      data-testid="pending-approvals-panel"
      className="[margin:12px_0] p-3 [border:1px_solid_var(--border)] rounded-lg [background:var(--surface-2,_var(--bg-elevated,_#f8fafc))]"
    >
      <h3 className="[margin:0_0_8px] [font-size:var(--text-body-sm)] font-semibold">
        Pending approvals
      </h3>
      <p className="[margin:0_0_12px] [font-size:var(--text-meta)] [color:var(--text-secondary)]">
        Review each tool before it runs. Deny cancels the pending action.
      </p>
      <ul className="[list-style:none] m-0 p-0 grid gap-2">
        {visible.map((item) => {
          const running = item.status === "running" || busy;
          const question = typeof item.input?.question === "string" ? item.input.question : "";
          const fields = item.toolId === "ask.user" ? askUserFields(item.input) : [];
          return (
            <li
              key={item.id}
              data-pending-id={item.id}
              className="flex flex-wrap items-center gap-2 justify-between"
            >
              <div className="grid gap-2 min-w-[12rem] flex-1">
                <div className="font-semibold [font-size:var(--text-meta)]">
                  {item.toolId === "ask.user" && question.length > 0 ? question : item.toolId}
                </div>
                {fields.map((field) => (
                  <label key={field.id} className="grid gap-1 [font-size:var(--text-meta)]">
                    {field.label}
                    {field.type === "select" ? (
                      <select
                        className="input sm"
                        disabled={running}
                        value={answers[item.id]?.[field.id] ?? ""}
                        onChange={(event) => {
                          const value = event.target.value;
                          setAnswers((current) => ({
                            ...current,
                            [item.id]: { ...current[item.id], [field.id]: value },
                          }));
                        }}
                      >
                        <option value="">Select</option>
                        {field.options.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    ) : field.type === "boolean" ? (
                      <input
                        type="checkbox"
                        disabled={running}
                        checked={answers[item.id]?.[field.id] === "true"}
                        onChange={(event) => {
                          const value = event.target.checked ? "true" : "false";
                          setAnswers((current) => ({
                            ...current,
                            [item.id]: { ...current[item.id], [field.id]: value },
                          }));
                        }}
                      />
                    ) : (
                      <input
                        type="text"
                        className="input sm"
                        disabled={running}
                        value={answers[item.id]?.[field.id] ?? ""}
                        onChange={(event) => {
                          const value = event.target.value;
                          setAnswers((current) => ({
                            ...current,
                            [item.id]: { ...current[item.id], [field.id]: value },
                          }));
                        }}
                      />
                    )}
                  </label>
                ))}
                {item.error !== undefined && item.error.length > 0 ? (
                  <div role="alert" className="text-destructive [font-size:var(--text-meta)]">
                    {item.error}
                  </div>
                ) : null}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn sm"
                  disabled={running}
                  onClick={() => {
                    onCancel(item);
                  }}
                >
                  Deny
                </button>
                <button
                  type="button"
                  className="btn primary sm"
                  disabled={running}
                  onClick={() => {
                    if (item.toolId === "ask.user")
                      onConfirm(item, { answers: answers[item.id] ?? {} });
                    else onConfirm(item);
                  }}
                >
                  {running ? "Working…" : "Approve"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
