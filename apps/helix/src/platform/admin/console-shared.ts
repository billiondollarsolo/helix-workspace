import type { Actor } from "@helix/sdk-types";
import type { FastifyReply } from "fastify";
import { z } from "zod";

/**
 * Shared helpers for the Admin Console backend domains (Groups & OUs,
 * Security policies, OAuth apps, Billing, Domain/DNS).
 *
 * Every domain reuses the same scope-gating, error envelope, cursor codec, and
 * Zod query primitives so the surfaces behave identically to the pre-existing
 * `admin/users` and `admin/services` routes.
 */

/** Top-level admin scope that grants every admin-console capability. */
export const adminWildcardScope = "admin.*";

/** Admin-console read scope: lists, gets, and read-only projections. */
export const adminConsoleReadScope = "admin.console.read";

/** Admin-console write scope: create / update / delete / revoke. */
export const adminConsoleWriteScope = "admin.console.write";

/**
 * Resolve whether `actor` may read an admin-console domain. The legacy
 * `admin.users` scope and the catch-all `admin.*` both imply read access so
 * existing admin operators are not locked out.
 */
export function canReadAdminConsole(actor: Actor): boolean {
  const scopes = actor.scopes ?? [];
  return (
    scopes.includes(adminConsoleReadScope) ||
    scopes.includes(adminConsoleWriteScope) ||
    scopes.includes("admin.users") ||
    scopes.includes(adminWildcardScope)
  );
}

/** Resolve whether `actor` may mutate an admin-console domain. */
export function canWriteAdminConsole(actor: Actor): boolean {
  const scopes = actor.scopes ?? [];
  return scopes.includes(adminConsoleWriteScope) || scopes.includes(adminWildcardScope);
}

/** Error envelope returned by every admin-console route. */
export interface AdminErrorEnvelope {
  readonly error: string;
  readonly code: AdminErrorCode;
  readonly requiredScope?: string;
  readonly issues?: unknown;
}

export type AdminErrorCode =
  | "forbidden"
  | "invalid_request"
  | "invalid_cursor"
  | "not_found"
  | "conflict";

/** Build a `403` envelope naming the scope the actor was missing. */
export function forbidden(requiredScope: string): AdminErrorEnvelope {
  return {
    error: "Admin console permission denied.",
    code: "forbidden",
    requiredScope,
  };
}

/** Build a `400` envelope for a failed Zod parse. */
export function invalidRequest(message: string, issues?: unknown): AdminErrorEnvelope {
  return issues === undefined
    ? { error: message, code: "invalid_request" }
    : { error: message, code: "invalid_request", issues };
}

/** Build a `400` envelope for a malformed pagination cursor. */
export function invalidCursor(): AdminErrorEnvelope {
  return { error: "Invalid pagination cursor.", code: "invalid_cursor" };
}

/** Build a `404` envelope. */
export function notFound(message: string): AdminErrorEnvelope {
  return { error: message, code: "not_found" };
}

/** Build a `409` envelope. */
export function conflict(message: string): AdminErrorEnvelope {
  return { error: message, code: "conflict" };
}

/** Send a `403` reply and return it (for `return reply…` route bodies). */
export function sendForbidden(reply: FastifyReply, requiredScope: string): FastifyReply {
  return reply.code(403).send(forbidden(requiredScope));
}

/**
 * Keyset cursor over a `(createdAt, id)` tuple. Encoded as base64url JSON so
 * it round-trips through query strings without escaping concerns.
 */
export interface KeysetCursor {
  readonly createdAt: Date;
  readonly id: string;
}

/** Encode a `(createdAt, id)` keyset cursor. */
export function encodeCursor(record: { readonly createdAt: string; readonly id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: record.createdAt, id: record.id }),
    "utf8",
  ).toString("base64url");
}

/** Decode a keyset cursor. Returns `null` when the cursor is malformed. */
export function decodeCursor(cursor: string): KeysetCursor | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const parsed = z
      .object({
        createdAt: z.string().datetime({ offset: true }),
        id: z.string().uuid(),
      })
      .safeParse(decoded);
    if (!parsed.success) {
      return null;
    }
    return { createdAt: new Date(parsed.data.createdAt), id: parsed.data.id };
  } catch {
    return null;
  }
}

/** Coerce empty query-string values to `undefined` before validating. */
export function emptyStringToUndefined<T extends z.ZodTypeAny>(
  schema: T,
): z.ZodEffects<T, z.output<T>, unknown> {
  return z.preprocess((value) => (value === "" ? undefined : value), schema);
}

/** Parse a query-string boolean (`"true"`/`"false"`) with a default. */
export function booleanQuery(): z.ZodEffects<
  z.ZodOptional<z.ZodBoolean>,
  boolean | undefined,
  unknown
> {
  return z.preprocess((value) => {
    if (value === "true" || value === true) {
      return true;
    }
    if (value === "false" || value === false || value === undefined) {
      return false;
    }
    return value;
  }, z.boolean().optional());
}

/** Standard `limit` query field — 1..200, default 50. */
export const limitQuerySchema = z.coerce.number().int().min(1).max(200).default(50);

/** Standard `cursor` query field. */
export const cursorQuerySchema = emptyStringToUndefined(
  z.string().trim().min(1).max(2000).optional(),
);

/**
 * Slice a one-extra-row store result into a page plus a `nextCursor`.
 * Callers fetch `limit + 1` rows so this helper can detect "more".
 */
export function paginate<T extends { readonly createdAt: string; readonly id: string }>(
  rows: readonly T[],
  limit: number,
): { readonly items: readonly T[]; readonly nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor = rows.length > limit && last !== undefined ? encodeCursor(last) : null;
  return { items, nextCursor };
}

/**
 * Audit sink shape used by admin-console write routes. Matches the subset of
 * `PostgresAuditStore.append` the admin domains rely on; the lead wires the
 * real store when registering routes.
 */
export interface AdminConsoleAuditSink {
  append(record: {
    readonly orgId: string;
    readonly actorId: string;
    readonly verb: string;
    readonly objectType: string;
    readonly objectId?: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<{ readonly id: string; readonly thisHash: string }>;
}

/**
 * Append an audit record, swallowing failures so an audit outage never blocks
 * an admin mutation. Admin writes are still authoritative; the audit trail is
 * best-effort here exactly as the broader platform treats activity logging.
 */
export async function auditAdminAction(
  sink: AdminConsoleAuditSink | undefined,
  record: {
    readonly orgId: string;
    readonly actorId: string;
    readonly verb: string;
    readonly objectType: string;
    readonly objectId?: string;
    readonly metadata?: Record<string, unknown>;
  },
): Promise<void> {
  if (sink === undefined) {
    return;
  }
  try {
    await sink.append(record);
  } catch {
    // Best-effort: audit failures must not roll back an admin mutation.
  }
}

/** Escape `%`, `_`, and `\` for safe use inside a SQL `LIKE` pattern. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}
