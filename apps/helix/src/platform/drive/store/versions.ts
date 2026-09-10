import { withTenantIoSagaPostgresContext as withTenantPostgresContext } from "../../tenancy/postgres-roles.js";
import { toSqlJson } from "../../util/sql.js";
import { isDriveBlobStorageKey } from "../core/dedup.js";
import { bytesFromDatabase } from "../core/mappers.js";
import { DriveNotFoundError } from "../errors.js";
import type { DriveVersionRecord } from "../types.js";
import { appendDriveActivity } from "./activity.js";
import { requireReadyObjectRole } from "./authz.js";
import { upsertDriveBlobRef } from "./blobs.js";
import { type DriveStoreContext } from "./context.js";
import { mapVersion } from "./mappers.js";
import { type DriveVersionRow, type SqlLike } from "./rows.js";
export async function getLatestDriveVersion(
  sql: SqlLike,
  orgId: string,
  objectId: string,
): Promise<DriveVersionRecord | null> {
  const rows = await sql<DriveVersionRow[]>`
    select * from drive_versions
    where org_id = ${orgId} and object_id = ${objectId}
    order by version_number desc limit 1
  `;
  return rows[0] === undefined ? null : mapVersion(rows[0]);
}

export async function listVersions(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  },
): Promise<readonly DriveVersionRecord[]> {
  await requireReadyObjectRole(context.sql, input.orgId, input.actorId, input.objectId, "reader");
  const rows = await context.sql<DriveVersionRow[]>`
      select *
      from drive_versions
      where org_id = ${input.orgId}
        and object_id = ${input.objectId}
      order by version_number desc
    `;
  return rows.map((row) => mapVersion(row));
}

export async function revertToVersion(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly versionNumber: number;
    readonly idempotencyKey?: string;
  },
): Promise<DriveVersionRecord> {
  const version = await withTenantPostgresContext(
    context.sql,
    { orgId: input.orgId, actorId: input.actorId },
    async (tx) => {
      await requireReadyObjectRole(tx, input.orgId, input.actorId, input.objectId, "editor");
      await tx`
        select id from objects
        where org_id = ${input.orgId} and id = ${input.objectId}
        for update
      `;
      if (input.idempotencyKey !== undefined) {
        const replay = await tx<DriveVersionRow[]>`
          select * from drive_versions
          where org_id = ${input.orgId} and object_id = ${input.objectId}
            and idempotency_key = ${input.idempotencyKey}
          limit 1
        `;
        if (replay[0] !== undefined) return mapVersion(replay[0]);
      }
      const targetRows = await tx<DriveVersionRow[]>`
        select *
        from drive_versions
        where org_id = ${input.orgId}
          and object_id = ${input.objectId}
          and version_number = ${input.versionNumber}
        limit 1
      `;
      const target = targetRows[0];
      if (target === undefined) {
        throw new DriveNotFoundError(
          `Unknown Drive version ${String(input.versionNumber)} for object ${input.objectId}.`,
        );
      }
      const maxRows = await tx<
        {
          readonly max_version: number;
        }[]
      >`
        select coalesce(max(version_number), 0)::int as max_version
        from drive_versions
        where org_id = ${input.orgId}
          and object_id = ${input.objectId}
      `;
      const nextVersion = (maxRows[0]?.max_version ?? 0) + 1;
      const inserted = await tx<DriveVersionRow[]>`
        insert into drive_versions (
          org_id, object_id, version_number, storage_key, mime_type, byte_size, sha256, metadata,
          created_by_actor_id, idempotency_key
        )
        values (
          ${input.orgId},
          ${input.objectId},
          ${nextVersion},
          ${target.storage_key},
          ${target.mime_type},
          ${target.byte_size},
          ${target.sha256},
          ${tx.json(
            toSqlJson({
              ...target.metadata,
              revertedFromVersion: input.versionNumber,
            }),
          )},
          ${input.actorId}, ${input.idempotencyKey ?? null}
        )
        returning *
      `;
      const insertedVersion = inserted[0];
      if (insertedVersion === undefined) throw new Error("Failed to create Drive version.");
      await tx`
        update objects
        set storage_key = ${target.storage_key},
            mime_type = ${target.mime_type},
            byte_size = ${target.byte_size},
            sha256 = ${target.sha256},
            metadata = (metadata - 'preview' - 'previewUrl' - 'previewText') || ${tx.json(
              toSqlJson({
                status: "ready",
                versionNumber: nextVersion,
                latestVersionId: insertedVersion.id,
              }),
            )}::jsonb,
            updated_at = now()
        where id = ${input.objectId}
          and org_id = ${input.orgId}
      `;
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.version.reverted",
        objectId: input.objectId,
        payload: { fromVersion: input.versionNumber, toVersion: nextVersion },
      });
      if (isDriveBlobStorageKey(target.storage_key)) {
        await upsertDriveBlobRef(tx, {
          orgId: input.orgId,
          sha256: target.sha256,
          storageKey: target.storage_key,
          byteSize: bytesFromDatabase(target.byte_size),
        });
      }
      return mapVersion(insertedVersion);
    },
  );
  return version;
}
