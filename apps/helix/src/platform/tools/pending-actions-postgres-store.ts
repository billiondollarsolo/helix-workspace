import type postgres from "postgres";
import type { Actor, JsonObject, JsonValue, PendingActionPreview } from "@helix/sdk";
import type {
  PendingActionCreateInput,
  PendingActionRecord,
  PendingActionStore,
} from "./registry.js";

interface PendingActionRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_id: string;
  readonly requester_credential_id: string | null;
  readonly requester_principal: Actor;
  readonly requester_ip: string | null;
  readonly approval_owner_actor_id: string | null;
  readonly approver_actor_id: string | null;
  readonly execution_actor_id: string | null;
  readonly tool_id: string;
  readonly input: JsonValue;
  readonly input_hash: string;
  readonly policy_snapshot: JsonObject;
  readonly policy_version: string;
  readonly preview: PendingActionPreview;
  readonly status: PendingActionRecord["status"];
  readonly expires_at: Date;
  readonly created_at: Date;
  readonly decided_at: Date | null;
  readonly approved_at: Date | null;
  readonly execution_started_at: Date | null;
  readonly execution_completed_at: Date | null;
  readonly execution_lease_expires_at: Date | null;
  readonly execution_attempts: number;
  readonly execution_idempotency_key: string;
  readonly trace_id: string | null;
  readonly result: JsonValue | null;
  readonly error: string | null;
}

const RETURNING_COLUMNS = `
  id, org_id, actor_id, requester_credential_id, requester_principal,
  requester_ip, approval_owner_actor_id, approver_actor_id, execution_actor_id,
  tool_id, input, input_hash, policy_snapshot, policy_version, preview, status,
  expires_at, created_at, decided_at, approved_at, execution_started_at,
  execution_completed_at, execution_lease_expires_at, execution_attempts,
  execution_idempotency_key, trace_id, result, error
`;

export class PostgresPendingActionStore implements PendingActionStore {
  constructor(private readonly sql: postgres.Sql) {}

  async create(input: PendingActionCreateInput): Promise<PendingActionRecord> {
    const rows = (await this.sql`
      insert into pending_actions (
        id, org_id, actor_id, requester_credential_id, requester_principal,
        requester_ip, approval_owner_actor_id, tool_id, input, input_hash,
        policy_snapshot, policy_version, preview, status, expires_at, created_at,
        execution_idempotency_key, trace_id
      )
      values (
        ${input.id}, ${input.orgId}, ${input.requesterActorId},
        ${input.requesterCredentialId}, ${this.sql.json(input.requesterPrincipal as unknown as JsonValue)},
        ${input.requesterIp}, ${input.approvalOwnerActorId}, ${input.toolId},
        ${this.sql.json(input.input)}, ${input.inputHash},
        ${this.sql.json(input.policySnapshot)}, ${input.policyVersion},
        ${this.sql.json(input.preview as unknown as JsonValue)}, ${"pending_confirmation"},
        ${input.expiresAt}, ${input.createdAt}, ${input.executionIdempotencyKey},
        ${input.traceId}
      )
      returning ${this.sql.unsafe(RETURNING_COLUMNS)}
    `) as unknown as readonly PendingActionRow[];
    const row = rows[0];
    if (row === undefined) throw new Error("Failed to create pending action.");
    return toPendingActionRecord(row);
  }

  async get(id: string): Promise<PendingActionRecord | null> {
    const rows = (await this.sql`
      select ${this.sql.unsafe(RETURNING_COLUMNS)}
      from pending_actions
      where id = ${id}
      limit 1
    `) as unknown as readonly PendingActionRow[];
    return rows[0] === undefined ? null : toPendingActionRecord(rows[0]);
  }

  async approve(input: {
    readonly id: string;
    readonly approverActorId: string;
    readonly approvedAt: Date;
  }): Promise<PendingActionRecord | null> {
    const rows = (await this.sql`
      update pending_actions
      set
        status = 'approved',
        approver_actor_id = ${input.approverActorId},
        approved_at = ${input.approvedAt},
        decided_at = ${input.approvedAt}
      where id = ${input.id}
        and status = 'pending_confirmation'
        and expires_at > ${input.approvedAt}
      returning ${this.sql.unsafe(RETURNING_COLUMNS)}
    `) as unknown as readonly PendingActionRow[];
    return rows[0] === undefined ? null : toPendingActionRecord(rows[0]);
  }

  async cancel(input: {
    readonly id: string;
    readonly actorId: string;
    readonly cancelledAt: Date;
  }): Promise<PendingActionRecord | null> {
    const rows = (await this.sql`
      update pending_actions
      set status = 'cancelled', decided_at = ${input.cancelledAt}
      where id = ${input.id}
        and status in ('pending_confirmation', 'approved')
      returning ${this.sql.unsafe(RETURNING_COLUMNS)}
    `) as unknown as readonly PendingActionRow[];
    return rows[0] === undefined ? null : toPendingActionRecord(rows[0]);
  }

  async claimExecution(input: {
    readonly id: string;
    readonly approverActorId: string;
    readonly executionActorId: string;
    readonly startedAt: Date;
    readonly leaseExpiresAt: Date;
  }): Promise<PendingActionRecord | null> {
    const rows = (await this.sql`
      update pending_actions
      set
        status = 'executing',
        execution_actor_id = ${input.executionActorId},
        execution_started_at = ${input.startedAt},
        execution_lease_expires_at = ${input.leaseExpiresAt},
        execution_attempts = execution_attempts + 1
      where id = ${input.id}
        and approver_actor_id = ${input.approverActorId}
        and expires_at > ${input.startedAt}
        and status = 'approved'
      returning ${this.sql.unsafe(RETURNING_COLUMNS)}
    `) as unknown as readonly PendingActionRow[];
    return rows[0] === undefined ? null : toPendingActionRecord(rows[0]);
  }

  async completeExecution(input: {
    readonly id: string;
    readonly executionActorId: string;
    readonly status: "executed" | "failed";
    readonly completedAt: Date;
    readonly traceId?: string;
    readonly result?: JsonValue;
    readonly error?: string;
  }): Promise<PendingActionRecord | null> {
    const rows = (await this.sql`
      update pending_actions
      set
        status = ${input.status},
        execution_completed_at = ${input.completedAt},
        execution_lease_expires_at = null,
        trace_id = coalesce(${input.traceId ?? null}, trace_id),
        result = ${input.result === undefined ? null : this.sql.json(input.result)},
        error = ${input.error ?? null}
      where id = ${input.id}
        and status = 'executing'
        and execution_actor_id = ${input.executionActorId}
      returning ${this.sql.unsafe(RETURNING_COLUMNS)}
    `) as unknown as readonly PendingActionRow[];
    return rows[0] === undefined ? null : toPendingActionRecord(rows[0]);
  }

  async expireStale(input: {
    readonly now: Date;
    readonly limit?: number;
  }): Promise<readonly PendingActionRecord[]> {
    const rows = (await this.sql`
      update pending_actions
      set status = 'expired', decided_at = ${input.now}
      where id in (
        select id
        from pending_actions
        where status in ('pending_confirmation', 'approved')
          and expires_at <= ${input.now}
        order by expires_at asc
        limit ${input.limit ?? 500}
        for update skip locked
      )
      returning ${this.sql.unsafe(RETURNING_COLUMNS)}
    `) as unknown as readonly PendingActionRow[];
    return rows.map(toPendingActionRecord);
  }

  async recoverStaleExecutions(input: {
    readonly now: Date;
    readonly limit?: number;
  }): Promise<readonly PendingActionRecord[]> {
    const rows = (await this.sql`
      update pending_actions
      set
        status = 'failed',
        error = 'execution_outcome_unknown',
        execution_completed_at = ${input.now},
        execution_lease_expires_at = null
      where id in (
        select id
        from pending_actions
        where status = 'executing'
          and execution_lease_expires_at <= ${input.now}
        order by execution_lease_expires_at asc
        limit ${input.limit ?? 500}
        for update skip locked
      )
      returning ${this.sql.unsafe(RETURNING_COLUMNS)}
    `) as unknown as readonly PendingActionRow[];
    return rows.map(toPendingActionRecord);
  }
}

function toPendingActionRecord(row: PendingActionRow): PendingActionRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    requesterActorId: row.actor_id,
    requesterCredentialId: row.requester_credential_id,
    requesterPrincipal: row.requester_principal,
    requesterIp: row.requester_ip,
    approvalOwnerActorId: row.approval_owner_actor_id,
    approverActorId: row.approver_actor_id,
    executionActorId: row.execution_actor_id,
    toolId: row.tool_id,
    input: row.input,
    inputHash: row.input_hash,
    policySnapshot: row.policy_snapshot,
    policyVersion: row.policy_version,
    preview: row.preview,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    approvedAt: row.approved_at,
    executionStartedAt: row.execution_started_at,
    executionCompletedAt: row.execution_completed_at,
    executionLeaseExpiresAt: row.execution_lease_expires_at,
    executionAttempts: row.execution_attempts,
    executionIdempotencyKey: row.execution_idempotency_key,
    traceId: row.trace_id,
    result: row.result,
    error: row.error,
  };
}
