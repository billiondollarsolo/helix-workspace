import type { JsonObject } from "@helix/sdk-types";
import { insertAuditActivity } from "../audit/append.js";
import type { ChatSql } from "./authorization.js";

const FORBIDDEN_AUDIT_KEYS = /(?:body|content|html|markdown|text)/iu;

/**
 * Appends a content-free Chat record to the platform hash chain inside the
 * caller's tenant transaction; the activity trigger chains and serializes it.
 */
export async function appendChatAudit(
  sql: ChatSql,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly verb: string;
    readonly objectType: "chat.room" | "chat.message" | "chat.export";
    readonly objectId: string;
    readonly metadata?: JsonObject | undefined;
  },
): Promise<void> {
  const metadata = input.metadata ?? {};
  assertContentFreeAudit(metadata);
  await insertAuditActivity(sql, {
    orgId: input.orgId,
    actorId: input.actorId,
    verb: input.verb,
    objectType: input.objectType,
    objectId: input.objectId,
    traceId: null,
    metadata,
  });
}

export function assertContentFreeAudit(value: JsonObject): void {
  visitAuditValue(value);
}

function visitAuditValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) visitAuditValue(entry);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_AUDIT_KEYS.test(key)) {
      throw new TypeError(`Chat audit metadata cannot contain content field "${key}".`);
    }
    visitAuditValue(child);
  }
}
