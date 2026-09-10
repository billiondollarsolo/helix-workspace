import type { JsonObject } from "@helix/sdk-types";
import type postgres from "postgres";
import { toSqlJson } from "../../util/sql.js";
import { type DriveScanClaimRow, type DriveScanFailureRow, type SqlLike } from "./rows.js";
export const DEFAULT_VIRUS_SCAN_MAX_ATTEMPTS = 5;

export const DEFAULT_VIRUS_SCAN_RETRY_DELAY_MS = 30000;

export async function recordDriveScanFailure(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly objectId: string;
    readonly actorId: string;
    readonly error: string;
    readonly finalizeMetadata: JsonObject;
    readonly maxAttempts: number;
    readonly retryDelayMs: number;
  },
): Promise<DriveScanFailureRow> {
  const maxAttempts = Math.max(1, Math.trunc(input.maxAttempts));
  const nextAttemptAt = new Date(Date.now() + Math.max(1, input.retryDelayMs));
  const initialStatus = maxAttempts === 1 ? "dead_lettered" : "pending";
  const rows = await sql<DriveScanFailureRow[]>`
    insert into drive_scan_jobs (
      org_id, object_id, actor_id, status, attempt_count, next_attempt_at,
      last_error, finalize_metadata
    )
    values (
      ${input.orgId}, ${input.objectId}, ${input.actorId}, ${initialStatus}, 1,
      ${initialStatus === "dead_lettered" ? null : nextAttemptAt},
      ${input.error}, ${sql.json(toSqlJson(input.finalizeMetadata))}
    )
    on conflict (org_id, object_id) do update
    set
      actor_id = excluded.actor_id,
      status = case
        when drive_scan_jobs.status <> 'processing' then drive_scan_jobs.status
        when drive_scan_jobs.attempt_count + 1 >= ${maxAttempts} then 'dead_lettered'
        else 'pending'
      end,
      attempt_count = case
        when drive_scan_jobs.status = 'processing' then drive_scan_jobs.attempt_count + 1
        else drive_scan_jobs.attempt_count
      end,
      next_attempt_at = case
        when drive_scan_jobs.status <> 'processing' then drive_scan_jobs.next_attempt_at
        when drive_scan_jobs.attempt_count + 1 >= ${maxAttempts} then null
        else ${nextAttemptAt}
      end,
      lease_expires_at = case
        when drive_scan_jobs.status = 'processing' then null
        else drive_scan_jobs.lease_expires_at
      end,
      last_error = excluded.last_error,
      finalize_metadata = excluded.finalize_metadata,
      updated_at = now()
    returning id, org_id, object_id, actor_id, status, attempt_count,
              next_attempt_at, finalize_metadata
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Failed to persist Drive antivirus retry state.");
  }
  return row;
}

export async function claimDriveScanJobs(
  sql: SqlLike,
  input: {
    readonly limit: number;
    readonly now: Date;
    readonly leaseExpiresAt: Date;
  },
): Promise<readonly DriveScanClaimRow[]> {
  return await sql<DriveScanClaimRow[]>`
    with candidates as (
      select jobs.id
      from drive_scan_jobs jobs
      join objects object on object.id = jobs.object_id and object.org_id = jobs.org_id
      where object.deleted_at is null
        and (
          (jobs.status = 'pending' and jobs.next_attempt_at <= ${input.now})
          or (jobs.status = 'processing' and jobs.lease_expires_at <= ${input.now})
        )
      order by jobs.next_attempt_at asc nulls first, jobs.created_at asc
      limit ${Math.max(1, Math.trunc(input.limit))}
      for update of jobs skip locked
    ), claimed as (
      update drive_scan_jobs jobs
      set status = 'processing', lease_expires_at = ${input.leaseExpiresAt}, updated_at = now()
      from candidates
      where jobs.id = candidates.id
      returning jobs.*
    )
    select claimed.*, object.owner_actor_id, object.storage_key, object.mime_type,
           object.byte_size, object.sha256
    from claimed
    join objects object on object.id = claimed.object_id and object.org_id = claimed.org_id
  `;
}

export async function listDriveScanOrgIds(
  sql: postgres.Sql,
  afterId: string | undefined,
  limit: number,
): Promise<readonly string[]> {
  const rows =
    afterId === undefined
      ? await sql<
          {
            readonly id: string;
          }[]
        >`
          select id from orgs
          order by id
          limit ${limit}
        `
      : await sql<
          {
            readonly id: string;
          }[]
        >`
          select id from orgs
          where id > ${afterId}::uuid
          order by id
          limit ${limit}
        `;
  return rows.map((row) => row.id);
}

export async function releaseDriveScanClaim(
  sql: SqlLike,
  input: {
    readonly id: string;
    readonly orgId: string;
    readonly error: string;
    readonly maxAttempts: number;
    readonly retryDelayMs: number;
  },
): Promise<DriveScanFailureRow | null> {
  const maxAttempts = Math.max(1, Math.trunc(input.maxAttempts));
  const nextAttemptAt = new Date(Date.now() + Math.max(1, input.retryDelayMs));
  const rows = await sql<DriveScanFailureRow[]>`
    update drive_scan_jobs
    set
      status = case when attempt_count + 1 >= ${maxAttempts} then 'dead_lettered' else 'pending' end,
      attempt_count = attempt_count + 1,
      next_attempt_at = case
        when attempt_count + 1 >= ${maxAttempts} then null
        else ${nextAttemptAt}
      end,
      lease_expires_at = null,
      last_error = ${input.error},
      updated_at = now()
    where id = ${input.id} and org_id = ${input.orgId} and status = 'processing'
    returning id, org_id, object_id, actor_id, status, attempt_count,
              next_attempt_at, finalize_metadata
  `;
  return rows[0] ?? null;
}

export async function updateDriveScanObjectState(
  sql: SqlLike,
  failure: DriveScanFailureRow,
): Promise<void> {
  await sql`
    update objects
    set metadata = metadata || jsonb_build_object(
          'status', ${failure.status === "dead_lettered" ? "scan_dead_letter" : "scan_pending"}::text,
          'avScanAttempts', ${failure.attempt_count}::integer,
          'avScanNextAttemptAt', ${failure.next_attempt_at?.toISOString() ?? null}::text
        ),
        updated_at = now()
    where org_id = ${failure.org_id} and id = ${failure.object_id}
  `;
}
