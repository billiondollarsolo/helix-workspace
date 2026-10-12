import type postgres from "postgres";
import { toSqlJson } from "../util/sql.js";

export interface AuditAppendResult {
  readonly id: string;
  readonly thisHash: string;
}

export interface AuditActivityInsert {
  readonly orgId: string;
  readonly actorId: string | null;
  readonly verb: string;
  readonly objectType: string;
  readonly objectId: string | null;
  readonly traceId: string | null;
  readonly metadata: Record<string, unknown>;
}

/**
 * The single append path for `activity`. The `activity_chain_integrity` trigger
 * (migration 0149) assigns `sequence`, `prev_hash` and `this_hash` while holding
 * the org's `audit_chain_heads` row lock, so concurrent appends for one org
 * serialize and the chain cannot fork. Callers run it inside a transaction whose
 * tenant context is already `orgId`; the runtime roles need only INSERT.
 */
export async function insertAuditActivity(
  sql: postgres.Sql | postgres.TransactionSql,
  record: AuditActivityInsert,
): Promise<AuditAppendResult> {
  const rows = await sql<{ readonly id: string; readonly this_hash: string }[]>`
    insert into activity (
      org_id,
      actor_id,
      verb,
      object_type,
      object_id,
      trace_id,
      payload,
      prev_hash,
      this_hash,
      created_at
    )
    values (
      ${record.orgId},
      ${record.actorId},
      ${record.verb},
      ${record.objectType},
      ${record.objectId},
      ${record.traceId},
      ${sql.json(toSqlJson(record.metadata))},
      null,
      '',
      ${new Date()}
    )
    returning id, this_hash
  `;
  return { id: rows[0]?.id ?? "", thisHash: rows[0]?.this_hash ?? "" };
}
