/**
 * Shared response-handling vocabulary for the admin console API modules.
 *
 * These four helpers existed as byte-identical copies in nine separate
 * `*-api.ts` modules under `features/admin`, so they live here once instead.
 * The only variation was `core-apps-api.ts`'s extra optional `fallback`
 * branch on `parseResponse`; that superset is the version kept below, and
 * with `fallback === undefined` it behaves exactly like the 3-argument copies.
 */

import { z } from "zod";
import { responseError } from "@/lib/tool-call";

/**
 * Parse and validate a backend response against a Zod schema.
 *
 * - On a non-OK HTTP status: throws with the backend error message.
 * - On a malformed-but-OK body: if `fallback` is provided, returns it (fail
 *   safe); otherwise throws so the caller's query surfaces an error state.
 */
export async function parseResponse<T>(
  response: Response,
  action: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  fallback?: T,
): Promise<T> {
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw responseError(
      response,
      payload,
      action,
      `Failed to ${action} (${String(response.status)}).`,
    );
  }
  throwIfAwaitingApproval(response, payload);
  const parsed = schema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`Failed to ${action}: malformed response.`);
}

/** What to tell an administrator whose change is waiting for another one. */
export function secondAdministratorRequired(approvalId: string): string {
  return `A second administrator must approve this change (request ${approvalId}). The requested change has not been applied. To work without a second administrator, turn off “Require a second administrator for sensitive actions” under Admin → Policies.`;
}

/** A 202 that parks the change for a second administrator is not a success. */
function throwIfAwaitingApproval(response: Response, payload: unknown): void {
  if (response.status !== 202) return;
  const approval = z
    .object({
      code: z.literal("crown_jewel_approval_required"),
      approval: z.object({ id: z.string() }),
    })
    .safeParse(payload);
  if (approval.success) throw new Error(secondAdministratorRequired(approval.data.approval.id));
}

export async function ensureOk(response: Response, action: string): Promise<void> {
  if (response.ok && response.status !== 202) {
    return;
  }
  const payload: unknown = await response.json().catch(() => ({}));
  if (response.ok) {
    throwIfAwaitingApproval(response, payload);
    return;
  }
  throw responseError(
    response,
    payload,
    action,
    `Failed to ${action} (${String(response.status)}).`,
  );
}

export function appendParam(params: URLSearchParams, key: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    params.set(key, trimmed);
  }
}
