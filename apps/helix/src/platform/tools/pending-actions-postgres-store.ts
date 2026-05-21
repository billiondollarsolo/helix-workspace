import type postgres from "postgres";
import type { JsonValue } from "@helix/sdk";
import type {
  PendingActionCreateInput,
  PendingActionRecord,
  PendingActionStore,
} from "./registry.js";

interface PendingActionRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_id: string;
  readonly tool_id: string;
  readonly input: JsonValue;
  readonly status: PendingActionRecord["status"];
  readonly expires_at: Date;
  readonly created_at: Date;
  readonly decided_at: Date | null;
  readonly trace_id: string | null;
  readonly result: JsonValue | null;
  readonly error: string | null;
}

export class PostgresPendingActionStore implements PendingActionStore {
  constructor(private readonly sql: postgres.Sql) {}

  async create(input: PendingActionCreateInput): Promise<PendingActionRecord> {
    const insertedRows = await this.sql`
      insert into pending_actions (
        org_id,
        actor_id,
        tool_id,
        input,
        status,
        expires_at,
        created_at,
        decided_at,
        trace_id,
        result,
        error
      )
      values (
        ${input.orgId},
        ${input.actorId},
        ${input.toolId},
        ${this.sql.json(input.input)},
        ${"pending_confirmation"},
        ${input.expiresAt},
        ${input.createdAt ?? new Date()},
        ${null},
        ${input.traceId ?? null},
        ${null},
        ${null}
      )
      returning id, org_id, actor_id, tool_id, input, status, expires_at, created_at, decided_at, trace_id, result, error
    `;
    const rows = insertedRows as unknown as readonly PendingActionRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Failed to create pending action.");
    }
    return toPendingActionRecord(row);
  }

  async get(id: string): Promise<PendingActionRecord | null> {
    const selectedRows = await this.sql`
      select id, org_id, actor_id, tool_id, input, status, expires_at, created_at, decided_at, trace_id, result, error
      from pending_actions
      where id = ${id}
      limit 1
    `;
    const rows = selectedRows as unknown as readonly PendingActionRow[];
    const row = rows[0];
    return row === undefined ? null : toPendingActionRecord(row);
  }

  async decide(input: {
    readonly id: string;
    readonly actorId: string;
    readonly status: "confirmed" | "cancelled";
    readonly decidedAt: Date;
  }): Promise<PendingActionRecord | null> {
    const updatedRows = await this.sql`
      update pending_actions
      set status = ${input.status}, decided_at = ${input.decidedAt}
      where id = ${input.id}
        and actor_id = ${input.actorId}
        and status = 'pending_confirmation'
      returning id, org_id, actor_id, tool_id, input, status, expires_at, created_at, decided_at, trace_id, result, error
    `;
    const rows = updatedRows as unknown as readonly PendingActionRow[];
    const row = rows[0];
    return row === undefined ? null : toPendingActionRecord(row);
  }

  async recordExecution(input: {
    readonly id: string;
    readonly actorId: string;
    readonly traceId?: string;
    readonly result?: JsonValue;
    readonly error?: string;
  }): Promise<PendingActionRecord | null> {
    const updatedRows = await this.sql`
      update pending_actions
      set
        trace_id = coalesce(${input.traceId ?? null}, trace_id),
        result = ${input.result === undefined ? null : this.sql.json(input.result)},
        error = ${input.error ?? null}
      where id = ${input.id}
        and actor_id = ${input.actorId}
        and status = 'confirmed'
      returning id, org_id, actor_id, tool_id, input, status, expires_at, created_at, decided_at, trace_id, result, error
    `;
    const rows = updatedRows as unknown as readonly PendingActionRow[];
    const row = rows[0];
    return row === undefined ? null : toPendingActionRecord(row);
  }

  async expireStale(input: {
    readonly now: Date;
    readonly limit?: number;
  }): Promise<readonly PendingActionRecord[]> {
    const limit = input.limit ?? 500;
    // Single statement: `for update skip locked` keeps the expiry worker
    // concurrency-safe even though it is leader-gated, and the join-update
    // pattern lets us return the affected rows.
    const updatedRows = await this.sql`
      update pending_actions
      set status = 'expired', decided_at = ${input.now}
      where id in (
        select id
        from pending_actions
        where status = 'pending_confirmation'
          and expires_at <= ${input.now}
        order by expires_at asc
        limit ${limit}
        for update skip locked
      )
      returning id, org_id, actor_id, tool_id, input, status, expires_at, created_at, decided_at, trace_id, result, error
    `;
    const rows = updatedRows as unknown as readonly PendingActionRow[];
    return rows.map(toPendingActionRecord);
  }
}

function toPendingActionRecord(row: PendingActionRow): PendingActionRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    toolId: row.tool_id,
    input: row.input,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    traceId: row.trace_id,
    result: row.result,
    error: row.error,
  };
}
