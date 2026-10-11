import type postgres from "postgres";
import {
  detachedFromTenantPostgresContext,
  withTenantPostgresContext,
} from "../../tenancy/postgres-roles.js";

/** Locks one folder's children for the rest of the folder transaction; null is My Drive's root. */
export type LockFolderChildren = (parentFolderId: string | null) => Promise<void>;

/** Runs folder work in its own committed tenant transaction (see `DriveS3Access`). */
export type DriveS3FolderTransaction = <T>(
  input: { readonly orgId: string; readonly actorId: string },
  work: (lockFolderChildren: LockFolderChildren) => Promise<T>,
) => Promise<T>;

/**
 * The advisory-lock key for creating children of a folder. It is per org and
 * parent, not per person, so two people uploading into the same shared folder
 * contend for it too. A My Drive root belongs to one person.
 */
export function driveFolderChildrenLockKey(
  input: { readonly orgId: string; readonly actorId: string },
  parentFolderId: string | null,
): string {
  return `drive-folder-children:${input.orgId}:${parentFolderId ?? `root:${input.actorId}`}`;
}

/**
 * S3 prefix folders are created in a fresh tenant transaction that commits on
 * its own. Before looking up or creating a child, the caller locks that parent's
 * children, so concurrent uploads into the same new folder, by one person or
 * several, take turns and reuse it instead of creating duplicates. Drive allows
 * folders with the same name (as people expect from a cloud drive), so this is
 * a lock rather than a unique constraint. Locks follow a key's path from the
 * root down, so two requests never wait on each other in opposite orders.
 */
export function createDriveS3FolderTransaction(sql: postgres.Sql): DriveS3FolderTransaction {
  return (input, work) =>
    detachedFromTenantPostgresContext(() =>
      withTenantPostgresContext(sql, input, (tx) =>
        work(async (parentFolderId) => {
          await tx`
            select pg_advisory_xact_lock(
              hashtextextended(${driveFolderChildrenLockKey(input, parentFolderId)}, 0)
            )
          `;
        }),
      ),
    );
}
