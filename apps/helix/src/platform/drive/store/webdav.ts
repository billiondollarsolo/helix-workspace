import { randomUUID } from "node:crypto";
import { BadRequestError } from "../../../api/api-error.js";
import { withTenantIoSagaPostgresContext as withTenantPostgresContext } from "../../tenancy/postgres-roles.js";
import type {
  AcquireDriveWebDavLockInput,
  DriveWebDavChangePage,
  DriveWebDavLock,
} from "../types.js";
import { UUID_RE } from "./activity.js";
import { type DriveStoreContext } from "./context.js";
import {
  type DriveWebDavChangeRow,
  type DriveWebDavCollectionRow,
  type DriveWebDavLockRow,
} from "./rows.js";
function mapDriveWebDavLock(row: DriveWebDavLockRow | undefined): DriveWebDavLock {
  if (row === undefined) throw new Error("Expected Drive WebDAV lock row.");
  return {
    pathKey: row.path_key,
    token: `opaquelocktoken:${row.token}`,
    actorId: row.actor_id,
    owner: row.owner,
    depth: row.depth,
    fence: String(row.fence),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function assertWebDavPathKey(value: string): void {
  if (!value.startsWith("/") || value.length > 4096 || value.includes("\0")) {
    throw new BadRequestError("Invalid WebDAV lock path.");
  }
}

function webDavLockUuid(token: string): string {
  const value = token.replace(/^opaquelocktoken:/u, "");
  if (!UUID_RE.test(value)) throw new BadRequestError("Invalid WebDAV lock token.");
  return value;
}

function webDavSyncVersion(value: string): string {
  if (!/^(0|[1-9][0-9]{0,18})$/u.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new BadRequestError("Invalid WebDAV sync token.");
  }
  return value;
}

export async function acquireWebDavLock(
  context: DriveStoreContext,
  input: AcquireDriveWebDavLockInput,
): Promise<DriveWebDavLock | null> {
  assertWebDavPathKey(input.pathKey);
  const refreshToken = input.token === undefined ? undefined : webDavLockUuid(input.token);
  return withTenantPostgresContext(
    context.sql,
    { orgId: input.orgId, actorId: input.actorId },
    async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${input.orgId}, 0))`;
      await tx`delete from drive_webdav_locks
          where org_id = ${input.orgId} and expires_at <= statement_timestamp()`;
      if (refreshToken !== undefined) {
        const rows = await tx<DriveWebDavLockRow[]>`
            update drive_webdav_locks
            set expires_at = statement_timestamp() + make_interval(secs => ${input.timeoutSeconds})
            where org_id = ${input.orgId} and path_key = ${input.pathKey}
              and actor_id = ${input.actorId} and token = ${refreshToken}::uuid
            returning *
          `;
        return rows[0] === undefined ? null : mapDriveWebDavLock(rows[0]);
      }
      const conflicts = await tx<DriveWebDavLockRow[]>`
          select * from drive_webdav_locks
          where org_id = ${input.orgId}
            and (
              path_key = ${input.pathKey}
              or (depth = 'infinity' and (path_key = '/' or ${input.pathKey} like path_key || '/%'))
              or (${input.depth} = 'infinity' and (${input.pathKey} = '/' or path_key like ${input.pathKey} || '/%'))
          )
          order by length(path_key) desc, fence desc
        `;
      if (conflicts[0] !== undefined) return null;
      const rows = await tx<DriveWebDavLockRow[]>`
          insert into drive_webdav_locks (
            org_id, path_key, token, actor_id, owner, depth, expires_at
          ) values (
            ${input.orgId}, ${input.pathKey}, ${randomUUID()}, ${input.actorId}, ${input.owner},
            ${input.depth}, statement_timestamp() + make_interval(secs => ${input.timeoutSeconds})
          )
          returning *
        `;
      return mapDriveWebDavLock(rows[0]);
    },
  );
}

export async function listWebDavLocks(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly pathKeys: readonly string[];
  },
): Promise<readonly DriveWebDavLock[]> {
  if (input.pathKeys.length === 0) return [];
  input.pathKeys.forEach(assertWebDavPathKey);
  return withTenantPostgresContext(
    context.sql,
    { orgId: input.orgId, actorId: input.actorId },
    async (tx) =>
      (
        await tx<DriveWebDavLockRow[]>`
          select lock.*
          from drive_webdav_locks lock
          where lock.org_id = ${input.orgId}
            and lock.expires_at > statement_timestamp()
            and exists (
              select 1 from unnest(${input.pathKeys}::text[]) requested(path_key)
              where lock.path_key = requested.path_key
                or (lock.depth = 'infinity' and (
                  lock.path_key = '/' or requested.path_key like lock.path_key || '/%'
                ))
            )
          order by length(lock.path_key) desc, lock.fence desc
        `
      ).map(mapDriveWebDavLock),
  );
}

export async function releaseWebDavLock(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly pathKey: string;
    readonly token: string;
  },
): Promise<boolean> {
  assertWebDavPathKey(input.pathKey);
  const token = webDavLockUuid(input.token);
  const rows = await withTenantPostgresContext(
    context.sql,
    { orgId: input.orgId, actorId: input.actorId },
    (tx) => tx`
        delete from drive_webdav_locks
        where org_id = ${input.orgId} and path_key = ${input.pathKey}
          and actor_id = ${input.actorId} and token = ${token}::uuid
        returning path_key
      `,
  );
  return rows.length === 1;
}

export async function listWebDavChanges(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly collectionPathKey: string;
    readonly afterVersion?: string;
    readonly limit: number;
  },
): Promise<DriveWebDavChangePage> {
  assertWebDavPathKey(input.collectionPathKey);
  const afterVersion =
    input.afterVersion === undefined ? undefined : webDavSyncVersion(input.afterVersion);
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 250);
  return withTenantPostgresContext(
    context.sql,
    { orgId: input.orgId, actorId: input.actorId },
    async (tx) => {
      // Match journal emission/pruning without requiring UPDATE permission for a read.
      await tx`select pg_advisory_xact_lock(hashtextextended(${input.orgId}::text, 157))`;
      const stateRows = await tx<DriveWebDavCollectionRow[]>`
          select version, min_version from drive_webdav_collections
          where org_id = ${input.orgId} and path_key = ${input.collectionPathKey}
        `;
      const current = String(stateRows[0]?.version ?? 0);
      const minimum = String(stateRows[0]?.min_version ?? 0);
      if (afterVersion === undefined) {
        return { changes: [], version: current, valid: true, hasMore: false };
      }
      if (stateRows[0] === undefined) {
        return { changes: [], version: "0", valid: afterVersion === "0", hasMore: false };
      }
      if (BigInt(afterVersion) < BigInt(minimum) || BigInt(afterVersion) > BigInt(current)) {
        return { changes: [], version: current, valid: false, hasMore: false };
      }
      const rows = await tx<DriveWebDavChangeRow[]>`
          select resource_path_key, resource_type, status, version
          from drive_webdav_changes
          where org_id = ${input.orgId} and collection_path_key = ${input.collectionPathKey}
            and version > ${afterVersion}::bigint
            and ${input.actorId}::uuid = any(audience_actor_ids)
          order by version
          limit ${limit + 1}
        `;
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return {
        changes: page.map((row) => ({
          pathKey: row.resource_path_key,
          resourceType: row.resource_type,
          status: row.status,
          version: String(row.version),
        })),
        version: hasMore ? String(page.at(-1)?.version ?? afterVersion) : current,
        valid: true,
        hasMore,
      };
    },
  );
}
