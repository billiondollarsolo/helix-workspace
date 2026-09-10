import type { JsonValue } from "@helix/sdk-types";
import { bytesFromDatabase } from "../core/mappers.js";
import {
  DriveConflictError,
  DriveNotFoundError,
  DriveStorageQuotaExceededError,
} from "../errors.js";
import { appendDriveActivity } from "./activity.js";
import { type DriveStoreContext } from "./context.js";
import {
  type DriveLifecyclePolicyRecord,
  type DriveStorageQuotaUsageRecord,
  type StorageQuotaExceededEvent,
} from "./contracts.js";
import { numberFromBigIntLike } from "./mappers.js";
import { type DriveStorageQuotaRow, type SqlLike, type StorageQuotaDecisionRow } from "./rows.js";
function storageLimitFromJson(value: JsonValue | null): number | null {
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 5000000000;
}

export async function reserveDriveStorageQuota(
  sql: SqlLike,
  orgId: string,
  objectId: string,
  byteSize: number,
  expiresAt: Date,
  onExceeded?: (event: Omit<StorageQuotaExceededEvent, "bucket" | "quota">) => void,
): Promise<void> {
  const rows = await sql<StorageQuotaDecisionRow[]>`
    select * from helix_reserve_drive_storage(
      ${orgId}, ${objectId}, ${byteSize}, ${expiresAt}
    )
  `;
  assertStorageQuotaDecision(orgId, byteSize, rows[0], onExceeded);
}

export async function commitStorageUsage(
  sql: SqlLike,
  orgId: string,
  objectId: string,
  byteDelta: number,
  bucket: "drive" | "chat" | "meet_recordings",
  onExceeded?: (event: Omit<StorageQuotaExceededEvent, "bucket" | "quota">) => void,
): Promise<void> {
  const rows = await sql<StorageQuotaDecisionRow[]>`
    select * from helix_commit_storage_usage(${orgId}, ${objectId}, ${byteDelta}, ${bucket})
  `;
  assertStorageQuotaDecision(orgId, byteDelta, rows[0], onExceeded);
}

function assertStorageQuotaDecision(
  orgId: string,
  byteDelta: number,
  row: StorageQuotaDecisionRow | undefined,
  onExceeded?: (event: Omit<StorageQuotaExceededEvent, "bucket" | "quota">) => void,
): void {
  if (row === undefined) throw new DriveNotFoundError("Unknown Drive tenant.");
  if (row.accepted) return;
  const limit = numberFromBigIntLike(row.limit_bytes);
  if (limit === null) throw new Error("Unlimited storage quota was unexpectedly rejected.");
  const used = bytesFromDatabase(row.used_bytes);
  const projected = bytesFromDatabase(row.projected_bytes);
  onExceeded?.({
    used_bytes: used,
    limit_bytes: limit,
    byte_delta: byteDelta,
    projected_bytes: projected,
  });
  throw new DriveStorageQuotaExceededError(orgId, limit, projected);
}

export async function getStorageQuotaUsage(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
  },
): Promise<DriveStorageQuotaUsageRecord> {
  const rows = await context.sql<readonly DriveStorageQuotaRow[]>`
      select
        case
          when o.quotas ? 'storage_bytes_limit' then o.quotas -> 'storage_bytes_limit'
          when p.quotas_default ? 'storage_bytes_limit' then p.quotas_default -> 'storage_bytes_limit'
          else '5000000000'::jsonb
        end as storage_bytes_limit,
        helix_storage_usage_bytes(${input.orgId}) as storage_used_bytes
      from orgs o
      left join plans p on p.id = o.plan_id
      where o.id = ${input.orgId}
      limit 1
    `;
  const row = rows[0];
  const usedBytes = row === undefined ? 0 : bytesFromDatabase(row.storage_used_bytes);
  const limitBytes = row === undefined ? 5000000000 : storageLimitFromJson(row.storage_bytes_limit);
  const unlimited = limitBytes === null;
  const percentUsed =
    unlimited || limitBytes === 0
      ? null
      : Math.min(100, Math.round((usedBytes / limitBytes) * 10000) / 100);
  return {
    orgId: input.orgId,
    usedBytes,
    limitBytes,
    unlimited,
    percentUsed,
  };
}

export async function getLifecyclePolicy(
  context: DriveStoreContext,
  input: { readonly orgId: string },
): Promise<DriveLifecyclePolicyRecord> {
  const rows = await context.sql<
    readonly {
      readonly org_id: string;
      readonly trash_retention_days: number;
      readonly orphan_grace_hours: number;
      readonly updated_by_actor_id: string | null;
      readonly updated_at: Date;
    }[]
  >`
      select org_id, trash_retention_days, orphan_grace_hours, updated_by_actor_id, updated_at
      from drive_lifecycle_policies
      where org_id = ${input.orgId}
      limit 1
    `;
  const row = rows[0];
  if (row === undefined) {
    return {
      orgId: input.orgId,
      trashRetentionDays: 30,
      orphanGraceHours: 24,
      updatedByActorId: null,
      updatedAt: null,
      configured: false,
    };
  }
  return {
    orgId: row.org_id,
    trashRetentionDays: row.trash_retention_days,
    orphanGraceHours: row.orphan_grace_hours,
    updatedByActorId: row.updated_by_actor_id,
    updatedAt: row.updated_at,
    configured: true,
  };
}

export async function setLifecyclePolicy(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly trashRetentionDays: number;
    readonly orphanGraceHours: number;
  },
): Promise<DriveLifecyclePolicyRecord> {
  if (
    !Number.isInteger(input.trashRetentionDays) ||
    input.trashRetentionDays < 1 ||
    input.trashRetentionDays > 3650
  ) {
    throw new DriveConflictError("trash_retention_days must be an integer from 1 to 3650.");
  }
  if (
    !Number.isInteger(input.orphanGraceHours) ||
    input.orphanGraceHours < 1 ||
    input.orphanGraceHours > 720
  ) {
    throw new DriveConflictError("orphan_grace_hours must be an integer from 1 to 720.");
  }
  const rows = await context.sql<
    readonly {
      readonly org_id: string;
      readonly trash_retention_days: number;
      readonly orphan_grace_hours: number;
      readonly updated_by_actor_id: string | null;
      readonly updated_at: Date;
    }[]
  >`
      insert into drive_lifecycle_policies (
        org_id, trash_retention_days, orphan_grace_hours, updated_by_actor_id, updated_at
      )
      values (
        ${input.orgId},
        ${input.trashRetentionDays},
        ${input.orphanGraceHours},
        ${input.actorId},
        now()
      )
      on conflict (org_id) do update set
        trash_retention_days = excluded.trash_retention_days,
        orphan_grace_hours = excluded.orphan_grace_hours,
        updated_by_actor_id = excluded.updated_by_actor_id,
        updated_at = now()
      returning org_id, trash_retention_days, orphan_grace_hours, updated_by_actor_id, updated_at
    `;
  const row = rows[0];
  if (row === undefined) {
    throw new DriveConflictError("Expected drive_lifecycle_policies row.");
  }
  await appendDriveActivity(context.sql, {
    orgId: input.orgId,
    actorId: input.actorId,
    // Org-scoped policy: record against the org id as the activity object.
    objectId: input.orgId,
    verb: "drive.lifecycle.policy_updated",
    payload: {
      trashRetentionDays: row.trash_retention_days,
      orphanGraceHours: row.orphan_grace_hours,
    },
  });
  return {
    orgId: row.org_id,
    trashRetentionDays: row.trash_retention_days,
    orphanGraceHours: row.orphan_grace_hours,
    updatedByActorId: row.updated_by_actor_id,
    updatedAt: row.updated_at,
    configured: true,
  };
}

export function emitStorageQuotaExceeded(
  context: DriveStoreContext,
  orgId: string,
  event: Omit<StorageQuotaExceededEvent, "bucket" | "quota">,
): void {
  context.options.metrics?.recordOperationalEvent({
    capability: "drive",
    operation: "quota",
    status: "blocked",
  });
  void context.options.events
    ?.publish("quota.storage.exceeded", {
      quota: "storage_bytes_limit",
      bucket: "drive",
      ...event,
    })
    .catch((error: unknown) => {
      context.options.onQuotaEventError?.(error);
    });
}
