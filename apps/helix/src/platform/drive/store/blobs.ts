import { randomUUID } from "node:crypto";
import type { DriveConfig } from "../config.js";
import { bytesFromDatabase, stringMetadata } from "../core/mappers.js";
import { type ObjectRow, type SqlLike } from "./rows.js";
export async function claimDriveBlobDestination(
  sql: SqlLike,
  orgId: string,
  objectId: string,
  sha256: string,
  baseStorageKey: string,
): Promise<{
  readonly storageKey: string;
  readonly referenced: boolean;
  readonly reservationId: string;
}> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`${orgId}:${sha256}`}, 0))`;
  const rows = await sql<
    {
      readonly storage_key: string;
      readonly refcount: number;
    }[]
  >`
    select storage_key, refcount
    from drive_blobs
    where org_id = ${orgId} and sha256 = ${sha256}
    for update
  `;
  const current = rows[0];
  const referenced = current !== undefined && current.refcount > 0;
  const deletionRows = await sql`
    select 1
    from drive_quarantine_deletions
    where org_id = ${orgId} and storage_key = ${current?.storage_key ?? baseStorageKey}
      and status in ('pending', 'processing')
    limit 1
  `;
  const storageKey = referenced
    ? current.storage_key
    : deletionRows[0] === undefined
      ? (current?.storage_key ?? baseStorageKey)
      : `${baseStorageKey}.${randomUUID()}`;
  await sql`
    insert into drive_blobs (org_id, sha256, storage_key, byte_size, refcount)
    values (${orgId}, ${sha256}, ${storageKey}, 0, 0)
    on conflict (org_id, sha256) do update
      set storage_key = excluded.storage_key, updated_at = now()
    where drive_blobs.refcount = 0
  `;
  const reservations = await sql<
    {
      readonly id: string;
    }[]
  >`
    insert into drive_blob_reservations (
      org_id, object_id, sha256, storage_key, expires_at
    ) values (
      ${orgId}, ${objectId}, ${sha256}, ${storageKey},
      ${new Date(Date.now() + 24 * 60 * 60 * 1000)}
    )
    on conflict (org_id, object_id) do update
      set sha256 = excluded.sha256, storage_key = excluded.storage_key,
          expires_at = excluded.expires_at, created_at = now()
    returning id
  `;
  const reservationId = reservations[0]?.id;
  if (reservationId === undefined) throw new Error("Failed to reserve Drive blob storage.");
  return { storageKey, referenced, reservationId };
}

export async function driveBlobStorageIsReferenced(
  sql: SqlLike,
  orgId: string,
  storageKey: string,
): Promise<boolean> {
  const rows = await sql`
    select 1
    where exists (
      select 1 from drive_blobs
      where org_id = ${orgId} and storage_key = ${storageKey} and refcount > 0
    ) or exists (
      select 1 from drive_blob_reservations
      where org_id = ${orgId} and storage_key = ${storageKey} and expires_at > now()
    )
    limit 1
  `;
  return rows[0] !== undefined;
}

export async function releaseDriveBlobReservation(
  sql: SqlLike,
  orgId: string,
  reservationId: string,
): Promise<void> {
  await sql`
    delete from drive_blob_reservations
    where org_id = ${orgId} and id = ${reservationId}
  `;
}

export async function reconcileDriveBlobReferences(
  sql: SqlLike,
  orgId: string,
  gc?: DriveConfig["gc"],
): Promise<void> {
  await sql`
    delete from drive_blob_reservations
    where org_id = ${orgId} and expires_at <= now()
  `;
  await sql`
    insert into drive_blobs (org_id, sha256, storage_key, byte_size, refcount)
    select org_id, lower(sha256), min(storage_key), max(byte_size), count(*)::integer
    from drive_versions
    where org_id = ${orgId} and storage_key like ${`drive/${orgId}/blobs/%`}
    group by org_id, lower(sha256)
    on conflict (org_id, sha256) do update
      set storage_key = excluded.storage_key, byte_size = excluded.byte_size,
          refcount = excluded.refcount, updated_at = now()
  `;
  await sql`
    update drive_blobs blob
    set refcount = 0, updated_at = now()
    where blob.org_id = ${orgId} and blob.refcount <> 0
      and not exists (
        select 1 from drive_versions version
        where version.org_id = blob.org_id and version.storage_key = blob.storage_key
      )
  `;
  await sql`
    insert into drive_quarantine_deletions (
      org_id, object_id, actor_id, storage_key, status, next_attempt_at
    )
    select blob.org_id, gen_random_uuid(), null, blob.storage_key, 'pending', now()
    from drive_blobs blob
    where blob.org_id = ${orgId} and blob.refcount = 0
      and blob.updated_at <= now() - coalesce(
        (select orphan_grace_hours from drive_lifecycle_policies where org_id = ${orgId}),
        ${gc?.orphanGraceHours ?? 24}
      ) * interval '1 hour'
      and not exists (
        select 1 from drive_blob_reservations reservation
        where reservation.org_id = blob.org_id
          and reservation.storage_key = blob.storage_key
          and reservation.expires_at > now()
      )
    order by blob.updated_at, blob.storage_key
    limit ${gc?.batchSize ?? 100}
    on conflict (org_id, storage_key) do update
      set status = 'pending', next_attempt_at = now(), lease_expires_at = null,
          completed_at = null, updated_at = now()
      where drive_quarantine_deletions.status = 'completed'
  `;
}

export async function upsertDriveBlobRef(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly sha256: string;
    readonly storageKey: string;
    readonly byteSize: number;
  },
): Promise<boolean> {
  const rows = await sql<
    {
      readonly newly_referenced: boolean;
    }[]
  >`
    insert into drive_blobs (org_id, sha256, storage_key, byte_size, refcount)
    values (${input.orgId}, ${input.sha256}, ${input.storageKey}, ${input.byteSize}, 1)
    on conflict (org_id, sha256) do update
      set refcount = drive_blobs.refcount + 1,
          storage_key = case when drive_blobs.refcount = 0 then excluded.storage_key else drive_blobs.storage_key end,
          byte_size = case when drive_blobs.refcount = 0 then excluded.byte_size else drive_blobs.byte_size end,
          updated_at = now()
    returning refcount = 1 as newly_referenced
  `;
  return rows[0]?.newly_referenced === true;
}

export async function decrementDriveBlobRef(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly storageKey: string;
    readonly amount: number;
  },
): Promise<number> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new TypeError("Drive blob reference decrement must be a positive safe integer.");
  }
  const rows = await sql<
    {
      readonly refcount: number;
    }[]
  >`
    update drive_blobs
    set refcount = refcount - ${input.amount},
        updated_at = now()
    where org_id = ${input.orgId}
      and storage_key = ${input.storageKey}
      and refcount >= ${input.amount}
    returning refcount
  `;
  const refcount = rows[0]?.refcount;
  if (refcount === undefined) {
    throw new Error("Drive blob refcount invariant does not match immutable versions.");
  }
  return refcount;
}

export function finalizedStorageDelta(
  current: ObjectRow,
  storageKey: string,
  byteSize: number,
): number {
  const status = stringMetadata(current.metadata, "status");
  if (status !== "ready") return byteSize;
  if (storageKey === current.storage_key) {
    return byteSize - bytesFromDatabase(current.byte_size);
  }
  return byteSize;
}
