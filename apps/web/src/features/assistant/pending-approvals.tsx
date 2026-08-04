/**
 * A12 — Pending tool-approval panel for Assistant.
 * Presentational + pure helpers; decisions go through applyAssistantToolDecision.
 */

import type { AssistantTurnPendingConfirmation } from "./api";
import type { ToolStatus } from "./tool-decisions";

export interface PendingApprovalItem extends AssistantTurnPendingConfirmation {
  readonly toolCallId?: string;
  readonly status?: ToolStatus;
  readonly error?: string;
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
  readonly onConfirm: (item: PendingApprovalItem) => void;
  readonly onCancel: (item: PendingApprovalItem) => void;
}

export function PendingApprovalsPanel({
  items,
  busy = false,
  onConfirm,
  onCancel,
}: PendingApprovalsPanelProps) {
  const visible = normalizePendingApprovals(items).filter(isActionablePendingApproval);
  if (visible.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="Pending tool approvals"
      data-testid="pending-approvals-panel"
      style={{
        margin: "12px 0",
        padding: 12,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--surface-2, var(--bg-elevated, #f8fafc))",
      }}
    >
      <h3 style={{ margin: "0 0 8px", fontSize: "var(--text-body-sm)", fontWeight: 600 }}>
        Pending approvals
      </h3>
      <p
        style={{ margin: "0 0 12px", fontSize: "var(--text-meta)", color: "var(--text-secondary)" }}
      >
        Review each tool before it runs. Deny cancels the pending action.
      </p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
        {visible.map((item) => {
          const running = item.status === "running" || busy;
          return (
            <li
              key={item.id}
              data-pending-id={item.id}
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 8,
                justifyContent: "space-between",
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: "var(--text-meta)" }}>{item.toolId}</div>
                {item.error !== undefined && item.error.length > 0 ? (
                  <div
                    role="alert"
                    style={{ color: "var(--danger)", fontSize: "var(--text-meta)" }}
                  >
                    {item.error}
                  </div>
                ) : null}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
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
                    onConfirm(item);
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
