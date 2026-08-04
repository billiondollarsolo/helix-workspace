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
  schema: z.ZodType<T>,
  fallback?: T,
): Promise<T> {
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorMessage(payload) ?? `Failed to ${action} (${String(response.status)}).`);
  }
  const parsed = schema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`Failed to ${action}: malformed response.`);
}

export async function ensureOk(response: Response, action: string): Promise<void> {
  if (response.ok) {
    return;
  }
  const payload: unknown = await response.json().catch(() => ({}));
  throw new Error(errorMessage(payload) ?? `Failed to ${action} (${String(response.status)}).`);
}

export function errorMessage(payload: unknown): string | undefined {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return undefined;
}

export function appendParam(params: URLSearchParams, key: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    params.set(key, trimmed);
  }
}
