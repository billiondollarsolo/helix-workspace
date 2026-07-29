import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import { computeAuditHash } from "../audit/hash.js";
import type { ChatSql } from "./authorization.js";

const FORBIDDEN_AUDIT_KEYS = /(?:body|content|html|markdown|text)/iu;

/** Appends a serialized, content-free Chat record to the platform hash chain. */
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
  await sql`select pg_advisory_xact_lock(hashtextextended(${input.orgId}, 77331))`;
  const previousRows = (await sql`
    select this_hash
    from activity
    where org_id = ${input.orgId}
    order by created_at desc, id desc
    limit 1
    for update
  `) as unknown as readonly { readonly this_hash: string }[];
  const prevHash = previousRows[0]?.this_hash ?? null;
  const createdAt = new Date();
  const { thisHash } = computeAuditHash(
    {
      actorId: input.actorId,
      verb: input.verb,
      objectType: input.objectType,
      objectId: input.objectId,
      metadata,
      createdAt: createdAt.toISOString(),
    },
    prevHash,
  );
  await sql`
    insert into activity (
      org_id, actor_id, verb, object_type, object_id,
      payload, prev_hash, this_hash, created_at
    )
    values (
      ${input.orgId}, ${input.actorId}, ${input.verb}, ${input.objectType},
      ${input.objectId}, ${sql.json(toSqlJson(metadata))}, ${prevHash},
      ${thisHash}, ${createdAt}
    )
  `;
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

function toSqlJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
