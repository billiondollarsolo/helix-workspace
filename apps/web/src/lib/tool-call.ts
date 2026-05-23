/* Shared tool-invocation helper used across feature surfaces.
 *
 * Helix tools flagged `confirmationRequired: true` (drive.delete,
 * mail.delete, mail.spam, calendar.event.delete, etc.) reply with
 * `{ status: "pending_confirmation", pending: { id } }` on first POST.
 * The web UI is meant to gather explicit user intent BEFORE invoking
 * these (the user clicked "Delete"), so we approve the pending action
 * inline and return the executed output — without this, the UI thinks
 * the call succeeded but the row never actually changed (the
 * long-running "delete doesn't work" bug).
 *
 * Every feature's tool client should route through `callTool` rather
 * than its own ad-hoc fetch wrapper. */

import { authenticatedFetch, type AuthFetch } from "@/lib/auth";

export type ToolFetch = AuthFetch;

export interface CallToolOptions {
  readonly fetchImpl?: ToolFetch;
  /** When true (default), automatically POSTs to
   *  `/api/tools/pending/<id>/approve` and returns the executed output. */
  readonly autoApprove?: boolean;
}

export async function callTool<Output = unknown>(
  toolId: string,
  input: unknown,
  options: CallToolOptions = {},
): Promise<Output> {
  const fetchImpl = options.fetchImpl ?? authenticatedFetch;
  const autoApprove = options.autoApprove !== false;

  const response = await fetchImpl(`/api/tools/${encodeURIComponent(toolId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const output: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      errorMessage(output) ?? `${toolId} failed with ${String(response.status)}`,
    );
  }

  if (autoApprove && isPendingConfirmation(output)) {
    return approvePending<Output>(output.pending.id, fetchImpl);
  }

  return output as Output;
}

export interface PendingConfirmationEnvelope {
  readonly status: "pending_confirmation";
  readonly pending: { readonly id: string };
}

export function isPendingConfirmation(value: unknown): value is PendingConfirmationEnvelope {
  return (
    isRecord(value) &&
    value.status === "pending_confirmation" &&
    isRecord(value.pending) &&
    typeof value.pending.id === "string"
  );
}

async function approvePending<Output>(
  pendingId: string,
  fetchImpl: ToolFetch,
): Promise<Output> {
  const response = await fetchImpl(
    `/api/tools/pending/${encodeURIComponent(pendingId)}/approve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  const output: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      errorMessage(output) ?? `pending action failed with ${String(response.status)}`,
    );
  }
  if (isRecord(output) && output.status === "executed") {
    return output.output as Output;
  }
  return output as Output;
}

function errorMessage(output: unknown): string | undefined {
  if (!isRecord(output)) return undefined;
  // Legacy plain `{ error: "..." }` payloads.
  if (typeof output.error === "string") return output.error;
  // Standard Helix error envelope: `{ error: { code, message, traceId } }`.
  if (isRecord(output.error) && typeof output.error.message === "string") {
    return output.error.message;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
