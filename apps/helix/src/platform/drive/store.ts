import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { JsonObject, StorageClient } from "@helix/sdk-types";
import { computeAuditHash } from "../audit/hash.js";
import { insertNotification } from "../notifications/store.js";
import { grantObjectAccess } from "../permissions/grant-object-access.js";
import type {
  DriveAutoTagWrite,
  DriveCommentListItem,
  DriveCommentRecord,
  DriveEnrichmentProjectionStore,
  DriveEnrichmentWrite,
  DriveEntryRecord,
  DrivePdfFormStateRecord,
  DrivePreview,
  DriveSearchProjectionStore,
  DriveSearchHit,
  DriveSearchRecord,
  DriveUploadRecord,
  DriveVersionRecord,
} from "./types.js";
import { officePreviewStorageKey, type OfficePreviewConverter } from "./preview.js";

export interface DriveStorageClient extends StorageClient {
  presignGetUrl?(
    key: string,
    options?: {
      readonly expiresSeconds?: number;
      readonly contentType?: string;
      readonly metadata?: Record<string, string>;
    },
  ): Promise<string>;
  presignPutUrl?(
    key: string,
    options?: {
      readonly expiresSeconds?: number;
      readonly contentType?: string;
      readonly metadata?: Record<string, string>;
    },
  ): Promise<string>;
}

export interface PrepareDriveUploadInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly name: string;
  readonly folderId?: string | null;
  readonly mimeType: string;
  readonly byteSize?: number;
  readonly sha256?: string;
  readonly metadata?: JsonObject;
}

export interface FinalizeDriveUploadInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly objectId: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly mimeType?: string;
  readonly storageKey?: string;
  readonly content?: Uint8Array;
  readonly metadata?: JsonObject;
}

export interface DriveStore {
  prepareUpload(input: PrepareDriveUploadInput): Promise<DriveUploadRecord>;
  finalizeUpload(input: FinalizeDriveUploadInput): Promise<DriveVersionRecord>;
  list(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId?: string | null;
    readonly includeTrashed?: boolean;
    readonly limit?: number;
    readonly app?: string | null;
    /** Filter by object kind. Defaults to 'file' so existing callers stay
     *  unchanged; pass 'recording' for the Recordings drive surface. */
    readonly kind?: string | null;
    readonly acrossFolders?: boolean;
  }): Promise<readonly DriveEntryRecord[]>;
  share(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly targetActorIds: readonly string[];
    readonly role: string;
    readonly expiresAt?: Date | null;
  }): Promise<{
    readonly objectId: string;
    readonly sharedWithActorIds: readonly string[];
    readonly role: string;
  }>;
  move(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly folderId?: string | null;
  }): Promise<DriveEntryRecord | null>;
  trash(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<DriveEntryRecord | null>;
  restore(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly folderId?: string | null;
  }): Promise<DriveEntryRecord | null>;
  delete(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<boolean>;
  search(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly query?: string;
    readonly folderId?: string | null;
    readonly limit?: number;
  }): Promise<readonly DriveSearchHit[]>;
  createFolder(input: DriveFolderCreateInput): Promise<DriveEntryRecord>;
  createComment?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly parentCommentId?: string | undefined;
    readonly body: string;
    readonly anchor?: JsonObject | undefined;
    readonly metadata?: JsonObject | undefined;
  }): Promise<DriveCommentRecord>;
  listComments?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly status?: string | undefined;
  }): Promise<readonly DriveCommentListItem[]>;
  resolveComment?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DriveCommentRecord | null>;
  reopenComment?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DriveCommentRecord | null>;
  updateComment?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
    readonly body: string;
  }): Promise<DriveCommentRecord | null>;
  deleteComment?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DriveCommentRecord | null>;
  getPdfFormState?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<DrivePdfFormStateRecord | null>;
  savePdfFormState?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly fieldValues: readonly JsonObject[];
  }): Promise<DrivePdfFormStateRecord>;
  clearPdfFormState?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<boolean>;
}

export interface DriveFolderCreateInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly name: string;
  readonly parentFolderId?: string | null;
  readonly metadata?: JsonObject;
}

export interface DriveFileReadInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly objectId: string;
}

export interface DriveFileReadResult {
  readonly entry: DriveEntryRecord;
  readonly content: Uint8Array | null;
}

export interface PostgresDriveStoreOptions {
  readonly officePreviewConverter?: OfficePreviewConverter;
}

interface ObjectRow {
  readonly id: string;
  readonly org_id: string;
  readonly owner_actor_id: string | null;
  readonly kind: string;
  readonly storage_key: string;
  readonly mime_type: string;
  readonly byte_size: number;
  readonly sha256: string | null;
  readonly metadata: JsonObject;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface DriveVersionRow {
  readonly id: string;
  readonly org_id: string;
  readonly object_id: string;
  readonly version_number: number;
  readonly storage_key: string;
  readonly mime_type: string;
  readonly byte_size: number;
  readonly sha256: string;
  readonly metadata: JsonObject;
  readonly created_by_actor_id: string | null;
  readonly created_at: Date;
}

interface DriveFolderRow {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly parent_folder_id: string | null;
  readonly owner_actor_id: string | null;
  readonly created_by_actor_id: string | null;
  readonly metadata: JsonObject;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface DriveSearchRow extends ObjectRow {
  readonly version_number: number | null;
}

interface DriveSearchProjectionRow extends ObjectRow {
  readonly owner_display_name: string | null;
  readonly owner_email: string | null;
  readonly folder_path: readonly string[];
}

interface DriveCommentRow {
  readonly id: string;
  readonly org_id: string;
  readonly object_id: string;
  readonly parent_comment_id: string | null;
  readonly actor_id: string | null;
  readonly anchor: JsonObject;
  readonly body: string;
  readonly status: string;
  readonly metadata: JsonObject;
  readonly resolved_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date | null;
}

interface DriveCommentProjectionRow extends DriveCommentRow {
  readonly actor_display_name: string | null;
  readonly actor_email: string | null;
}

interface DrivePdfFormStateRow {
  readonly org_id: string;
  readonly object_id: string;
  readonly actor_id: string;
  readonly field_values: readonly JsonObject[];
  readonly source_version_number: number | null;
  readonly source_sha256: string | null;
  readonly source_byte_size: string | number | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly current_source_version_number?: number | null;
  readonly current_source_sha256?: string | null;
  readonly current_source_byte_size?: string | number | null;
}

type SqlLike = postgres.Sql | postgres.TransactionSql;

interface PdfFormSourceMetadata {
  readonly versionNumber: number | null;
  readonly sha256: string | null;
  readonly byteSize: number | null;
}

export class PostgresDriveStore
  implements DriveStore, DriveSearchProjectionStore, DriveEnrichmentProjectionStore
{
  constructor(
    private readonly sql: postgres.Sql,
    private readonly storage?: DriveStorageClient,
    private readonly options: PostgresDriveStoreOptions = {},
  ) {}

  async prepareUpload(input: PrepareDriveUploadInput): Promise<DriveUploadRecord> {
    return this.sql.begin(async (tx) => {
      if (input.folderId !== undefined && input.folderId !== null) {
        await requireFolderAccess(tx, input.orgId, input.actorId, input.folderId);
      }

      const objectId = randomUUID();
      const storageKey = driveStorageKey(input.orgId, objectId, 1, input.name);
      const metadata = driveObjectMetadata({
        ...(input.metadata ?? {}),
        name: input.name,
        folderId: input.folderId ?? null,
        status: "pending_upload",
      });
      const rows = (await tx`
        insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
        values (
          ${objectId},
          ${input.orgId},
          ${input.actorId},
          'file',
          ${storageKey},
          ${input.mimeType},
          ${input.byteSize ?? 0},
          ${input.sha256 ?? null},
          ${tx.json(toSqlJson(metadata))}
        )
        returning *
      `) as unknown as readonly ObjectRow[];

      await grantObjectAccess(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        objectId,
        role: "owner",
        grantedByActorId: input.actorId,
      });
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.upload.prepared",
        objectId,
        payload: {
          name: input.name,
          folderId: input.folderId ?? null,
          storageKey,
        },
      });

      return {
        ...mapUpload(rows[0]),
        uploadUrl: await this.presignPutUrl(storageKey, input.mimeType),
      };
    });
  }

  async finalizeUpload(input: FinalizeDriveUploadInput): Promise<DriveVersionRecord> {
    return this.sql.begin(async (tx) => {
      const current = await requireObjectAccess(tx, input.orgId, input.actorId, input.objectId);
      const storageKey = input.storageKey ?? current.storage_key;
      const mimeType = input.mimeType ?? current.mime_type;
      if (input.content !== undefined) {
        const actualSha256 = createHash("sha256").update(input.content).digest("hex");
        if (actualSha256 !== input.sha256) {
          throw new Error("Drive upload sha256 does not match provided content.");
        }
        await this.storage?.put({
          key: storageKey,
          body: input.content,
          contentType: mimeType,
          metadata: { objectId: input.objectId, sha256: input.sha256 },
        });
      }

      const versionRows = (await tx`
        insert into drive_versions (
          org_id, object_id, version_number, storage_key, mime_type, byte_size, sha256, metadata, created_by_actor_id
        )
        values (
          ${input.orgId},
          ${input.objectId},
          coalesce((select max(version_number) + 1 from drive_versions where object_id = ${input.objectId}), 1),
          ${storageKey},
          ${mimeType},
          ${input.byteSize},
          ${input.sha256},
          ${tx.json(toSqlJson(input.metadata ?? {}))},
          ${input.actorId}
        )
        returning *
      `) as unknown as readonly DriveVersionRow[];
      const version = mapVersion(versionRows[0]);
      const preview = await this.generatePreview({
        orgId: input.orgId,
        objectId: input.objectId,
        name: stringMetadata(current.metadata, "name") ?? current.storage_key,
        storageKey,
        mimeType,
        versionNumber: version.versionNumber,
        ...(input.content === undefined ? {} : { inlineContent: input.content }),
      });

      await tx`
        update objects
        set
          storage_key = ${storageKey},
          mime_type = ${mimeType},
          byte_size = ${input.byteSize},
          sha256 = ${input.sha256},
          metadata = ${tx.json(
            toSqlJson({
              ...current.metadata,
              status: "ready",
              latestVersionId: version.id,
              versionNumber: version.versionNumber,
              ...preview,
            }),
          )},
          updated_at = now()
        where id = ${input.objectId} and org_id = ${input.orgId}
      `;
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.upload.finalized",
        objectId: input.objectId,
        payload: {
          versionId: version.id,
          versionNumber: version.versionNumber,
          byteSize: input.byteSize,
          sha256: input.sha256,
        },
      });

      return version;
    });
  }

  async list(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId?: string | null;
    readonly includeTrashed?: boolean;
    readonly limit?: number;
    readonly app?: string | null;
    /** Filter by object kind. Defaults to 'file'; the Recordings drive
     *  scope passes 'recording'. */
    readonly kind?: string | null;
    /** When true, return every visible file regardless of which folder
     *  it lives in. Used by the typed surfaces (`/docs`, `/sheets`,
     *  `/slides`) which present a cross-folder app-shaped list. Folder
     *  rows are suppressed in this mode — the result is a flat file list. */
    readonly acrossFolders?: boolean;
  }): Promise<readonly DriveEntryRecord[]> {
    // When filtering for non-file kinds (e.g. 'recording'), the folder
    // hierarchy doesn't apply — those objects don't live in user-managed
    // folders. Force acrossFolders=true so we skip the folder rows and the
    // folderId metadata match.
    const kind = input.kind ?? "file";
    const acrossFolders = input.acrossFolders === true || kind !== "file";
    if (input.folderId !== undefined && input.folderId !== null && !acrossFolders) {
      await requireFolderAccess(this.sql, input.orgId, input.actorId, input.folderId);
    }
    const folderRows = acrossFolders
      ? ([] as readonly DriveFolderRow[])
      : ((await this.sql`
          select *
          from drive_folders
          where org_id = ${input.orgId}
            and (
              (${input.folderId ?? null}::uuid is null and parent_folder_id is null)
              or parent_folder_id = ${input.folderId ?? null}
            )
            and (${input.includeTrashed ?? false} or deleted_at is null)
            and ${canReadFolderSql(this.sql, input.actorId)}
          order by name asc
          limit ${input.limit ?? 100}
        `) as unknown as readonly DriveFolderRow[]);

    const fileRows = (await this.sql`
      select o.*, (select max(version_number) from drive_versions v where v.object_id = o.id) as version_number
      from objects o
      where o.org_id = ${input.orgId}
        and o.kind = ${kind}
        and (
          ${acrossFolders}
          or coalesce(o.metadata->>'folderId', '') = coalesce(${input.folderId ?? null}::text, '')
        )
        and (${input.includeTrashed ?? false} or o.deleted_at is null)
        and (${input.app ?? null}::text is null or coalesce(o.metadata->>'app', 'file') = ${input.app ?? null})
        and (
          o.owner_actor_id = ${input.actorId}
          or exists (
            select 1 from permissions p
            where p.resource_type = 'object'
              and p.resource_id = o.id
              and p.actor_id = ${input.actorId}
              and (p.expires_at is null or p.expires_at > now())
          )
        )
      order by coalesce(o.metadata->>'name', o.storage_key) asc
      limit ${input.limit ?? 100}
    `) as unknown as readonly DriveSearchRow[];

    return [...folderRows.map(mapFolderEntry), ...fileRows.map(mapObjectEntry)].slice(
      0,
      input.limit ?? 100,
    );
  }

  async createFolder(input: DriveFolderCreateInput): Promise<DriveEntryRecord> {
    return this.sql.begin(async (tx) => {
      if (input.parentFolderId !== undefined && input.parentFolderId !== null) {
        await requireFolderAccess(tx, input.orgId, input.actorId, input.parentFolderId);
      }
      const rows = (await tx`
        insert into drive_folders (
          org_id,
          name,
          parent_folder_id,
          owner_actor_id,
          created_by_actor_id,
          metadata
        )
        values (
          ${input.orgId},
          ${input.name},
          ${input.parentFolderId ?? null},
          ${input.actorId},
          ${input.actorId},
          ${tx.json(toSqlJson(input.metadata ?? {}))}
        )
        returning *
      `) as unknown as readonly DriveFolderRow[];
      const folder = mapFolderEntry(rows[0] ?? missingFolderRow());
      await grantFolderAccess(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        folderId: folder.id,
        role: "owner",
        grantedByActorId: input.actorId,
      });
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.folder.created",
        objectId: folder.id,
        payload: { name: input.name, parentFolderId: input.parentFolderId ?? null },
      });
      return folder;
    });
  }

  async trashFolder(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId: string;
  }): Promise<DriveEntryRecord | null> {
    return this.sql.begin(async (tx) => {
      const rows = (await tx`
        with recursive folder_tree as (
          select *
          from drive_folders
          where id = ${input.folderId}
            and org_id = ${input.orgId}
            and deleted_at is null
            and ${canReadFolderSql(tx, input.actorId)}
          union all
          select child.*
          from drive_folders child
          join folder_tree parent on child.parent_folder_id = parent.id
          where child.org_id = ${input.orgId}
            and child.deleted_at is null
        ),
        trashed_files as (
          update objects
          set deleted_at = now(), updated_at = now()
          where org_id = ${input.orgId}
            and kind = 'file'
            and deleted_at is null
            and metadata->>'folderId' in (select id::text from folder_tree)
          returning id, metadata
        ),
        trashed_docs as (
          update docs_documents
          set deleted_at = now(), updated_at = now()
          where org_id = ${input.orgId}
            and id in (
              select id
              from trashed_files
              where metadata->>'app' = 'docs'
            )
          returning id
        ),
        trashed_folders as (
          update drive_folders
          set deleted_at = now(), updated_at = now()
          where id in (select id from folder_tree)
          returning *
        )
        select *
        from trashed_folders
        where id = ${input.folderId}
        limit 1
      `) as unknown as readonly DriveFolderRow[];
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.folder.trashed",
        objectId: input.folderId,
        payload: { name: row.name, parentFolderId: row.parent_folder_id },
      });
      return mapFolderEntry(row);
    });
  }

  async readFile(input: DriveFileReadInput): Promise<DriveFileReadResult | null> {
    const object = await requireObjectAccess(this.sql, input.orgId, input.actorId, input.objectId);
    if (object.deleted_at !== null) {
      return null;
    }
    const versionRows = (await this.sql`
      select max(version_number) as version_number
      from drive_versions
      where object_id = ${input.objectId}
    `) as unknown as readonly { readonly version_number: number | null }[];
    const content = await this.readObjectBytes(object.storage_key);
    return {
      entry: mapObjectEntry({
        ...object,
        version_number: versionRows[0]?.version_number ?? null,
      }),
      content: content ?? null,
    };
  }

  async share(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly targetActorIds: readonly string[];
    readonly role: string;
    readonly expiresAt?: Date | null;
  }): Promise<{
    readonly objectId: string;
    readonly sharedWithActorIds: readonly string[];
    readonly role: string;
  }> {
    return this.sql.begin(async (tx) => {
      await requireObjectAccess(tx, input.orgId, input.actorId, input.objectId);
      const sharedWithActorIds = [...new Set(input.targetActorIds)];
      for (const targetActorId of sharedWithActorIds) {
        await tx`
          insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id, expires_at)
          values (${input.orgId}, ${targetActorId}, 'object', ${input.objectId}, ${input.role}, ${input.actorId}, ${input.expiresAt ?? null})
          on conflict do nothing
        `;
      }
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.object.shared",
        objectId: input.objectId,
        payload: { sharedWithActorIds, role: input.role },
      });
      return { objectId: input.objectId, sharedWithActorIds, role: input.role };
    });
  }

  async move(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly folderId?: string | null;
  }): Promise<DriveEntryRecord | null> {
    return this.updateFileFolder({
      ...input,
      verb: "drive.object.moved",
      restore: false,
    });
  }

  async trash(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<DriveEntryRecord | null> {
    return this.sql.begin(async (tx) => {
      const rows = (await tx`
        update objects
        set deleted_at = now(), updated_at = now()
        where id = ${input.objectId}
          and org_id = ${input.orgId}
          and kind = 'file'
          and deleted_at is null
          and ${canReadObjectSql(tx, input.actorId)}
        returning *, (select max(version_number) from drive_versions v where v.object_id = objects.id) as version_number
      `) as unknown as readonly DriveSearchRow[];
      if (rows[0] !== undefined) {
        await syncTargetDeletedAt(tx, input.orgId, input.objectId, "trash");
        await appendDriveActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "drive.object.trashed",
          objectId: input.objectId,
          payload: {},
        });
      }
      return rows[0] === undefined ? null : mapObjectEntry(rows[0]);
    });
  }

  async restore(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly folderId?: string | null;
  }): Promise<DriveEntryRecord | null> {
    return this.updateFileFolder({
      ...input,
      verb: "drive.object.restored",
      restore: true,
    });
  }

  async delete(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const object = await requireObjectAccess(tx, input.orgId, input.actorId, input.objectId);
      const versionRows = (await tx`
        select storage_key from drive_versions where object_id = ${input.objectId}
      `) as unknown as readonly { readonly storage_key: string }[];
      await tx`delete from permissions where resource_type = 'object' and resource_id = ${input.objectId}`;
      await tx`delete from drive_versions where object_id = ${input.objectId}`;
      // syncTargetDeletedAt no-ops when the object has no linked app, so it is
      // called unconditionally here — matching the trash and restore paths.
      await syncTargetDeletedAt(tx, input.orgId, input.objectId, "trash");
      const deleted = await tx`
        delete from objects
        where id = ${input.objectId} and org_id = ${input.orgId} and kind = 'file'
      `;
      if (deleted.count > 0) {
        for (const storageKey of new Set([
          object.storage_key,
          ...versionRows.map((row) => row.storage_key),
        ])) {
          await this.storage?.delete(storageKey);
        }
        await appendDriveActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "drive.object.deleted",
          objectId: input.objectId,
          payload: {},
        });
      }
      return deleted.count > 0;
    });
  }

  async search(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly query?: string;
    readonly folderId?: string | null;
    readonly limit?: number;
  }): Promise<readonly DriveSearchHit[]> {
    const query = input.query ?? "";
    const rows = (await this.sql`
      select o.*, (select max(version_number) from drive_versions v where v.object_id = o.id) as version_number
      from objects o
      where o.org_id = ${input.orgId}
        and o.kind = 'file'
        and o.deleted_at is null
        and (${input.folderId ?? null}::uuid is null or o.metadata->>'folderId' = ${input.folderId ?? null})
        and (${query} = '' or coalesce(o.metadata->>'name', o.storage_key) ilike ${`%${query}%`} or o.mime_type ilike ${`%${query}%`})
        and (
          o.owner_actor_id = ${input.actorId}
          or exists (
            select 1 from permissions p
            where p.resource_type = 'object'
              and p.resource_id = o.id
              and p.actor_id = ${input.actorId}
              and (p.expires_at is null or p.expires_at > now())
          )
        )
      order by o.updated_at desc
      limit ${input.limit ?? 50}
    `) as unknown as readonly DriveSearchRow[];
    return rows.map(mapSearchHit);
  }

  async createComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly parentCommentId?: string | undefined;
    readonly body: string;
    readonly anchor?: JsonObject | undefined;
    readonly metadata?: JsonObject | undefined;
  }): Promise<DriveCommentRecord> {
    return this.sql.begin(async (tx) => {
      const object = await requireObjectAccess(tx, input.orgId, input.actorId, input.objectId);
      if (input.parentCommentId !== undefined) {
        await requireDriveCommentParent(tx, {
          orgId: input.orgId,
          objectId: input.objectId,
          parentCommentId: input.parentCommentId,
        });
      }
      const rows = (await tx`
        insert into drive_comments
          (org_id, object_id, parent_comment_id, actor_id, anchor, body, metadata)
        values (
          ${input.orgId},
          ${input.objectId},
          ${input.parentCommentId ?? null},
          ${input.actorId},
          ${tx.json(toSqlJson(input.anchor ?? {}))},
          ${input.body},
          ${tx.json(toSqlJson(input.metadata ?? {}))}
        )
        returning *
      `) as unknown as readonly DriveCommentRow[];
      const comment = mapDriveComment(rows[0]);
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.comment.created",
        objectId: input.objectId,
        payload: { commentId: comment.id, parentCommentId: comment.parentCommentId },
      });
      await notifyDriveCommentMentions(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        object,
        commentId: comment.id,
        parentCommentId: comment.parentCommentId,
        anchor: comment.anchor,
        body: input.body,
        metadata: comment.metadata,
      });
      return comment;
    });
  }

  async listComments(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly status?: string | undefined;
  }): Promise<readonly DriveCommentListItem[]> {
    await requireObjectAccess(this.sql, input.orgId, input.actorId, input.objectId);
    const rows = (await this.sql`
      select
        c.*,
        a.display_name as actor_display_name,
        a.email as actor_email
      from drive_comments c
      left join actors a on a.id = c.actor_id and a.org_id = c.org_id
      where c.org_id = ${input.orgId}
        and c.object_id = ${input.objectId}
        ${
          input.status === undefined || input.status === "all"
            ? this.sql``
            : this.sql`and c.status = ${input.status}`
        }
      order by c.created_at asc, c.id asc
    `) as unknown as readonly DriveCommentProjectionRow[];
    return rows.map(mapDriveCommentListItem);
  }

  async resolveComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DriveCommentRecord | null> {
    return this.sql.begin(async (tx) => {
      const existingRows = (await tx`
        select *
        from drive_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        limit 1
      `) as unknown as readonly DriveCommentRow[];
      const existing = existingRows[0];
      if (existing === undefined) {
        return null;
      }
      await requireObjectAccess(tx, input.orgId, input.actorId, existing.object_id);
      if (existing.status === "resolved") {
        return mapDriveComment(existing);
      }
      const rows = (await tx`
        update drive_comments
        set status = 'resolved', resolved_at = now(), updated_at = now()
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        returning *
      `) as unknown as readonly DriveCommentRow[];
      const comment = mapDriveComment(rows[0]);
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.comment.resolved",
        objectId: comment.objectId,
        payload: { commentId: comment.id },
      });
      return comment;
    });
  }

  async reopenComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DriveCommentRecord | null> {
    return this.sql.begin(async (tx) => {
      const existingRows = (await tx`
        select *
        from drive_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        limit 1
      `) as unknown as readonly DriveCommentRow[];
      const existing = existingRows[0];
      if (existing === undefined) {
        return null;
      }
      await requireObjectAccess(tx, input.orgId, input.actorId, existing.object_id);
      if (existing.status === "open") {
        return mapDriveComment(existing);
      }
      const rows = (await tx`
        update drive_comments
        set status = 'open', resolved_at = null, updated_at = now()
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        returning *
      `) as unknown as readonly DriveCommentRow[];
      const comment = mapDriveComment(rows[0]);
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.comment.reopened",
        objectId: comment.objectId,
        payload: { commentId: comment.id },
      });
      return comment;
    });
  }

  async updateComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
    readonly body: string;
  }): Promise<DriveCommentRecord | null> {
    return this.sql.begin(async (tx) => {
      const existingRows = (await tx`
        select *
        from drive_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        limit 1
      `) as unknown as readonly DriveCommentRow[];
      const existing = existingRows[0];
      if (existing === undefined) {
        return null;
      }
      await requireObjectAccess(tx, input.orgId, input.actorId, existing.object_id);
      const rows = (await tx`
        update drive_comments
        set body = ${input.body}, updated_at = now()
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        returning *
      `) as unknown as readonly DriveCommentRow[];
      const comment = mapDriveComment(rows[0]);
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.comment.updated",
        objectId: comment.objectId,
        payload: { commentId: comment.id },
      });
      return comment;
    });
  }

  async deleteComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DriveCommentRecord | null> {
    return this.sql.begin(async (tx) => {
      const existingRows = (await tx`
        select *
        from drive_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        limit 1
      `) as unknown as readonly DriveCommentRow[];
      const existing = existingRows[0];
      if (existing === undefined) {
        return null;
      }
      await requireObjectAccess(tx, input.orgId, input.actorId, existing.object_id);
      const rows = (await tx`
        delete from drive_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        returning *
      `) as unknown as readonly DriveCommentRow[];
      const comment = mapDriveComment(rows[0]);
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.comment.deleted",
        objectId: comment.objectId,
        payload: { commentId: comment.id },
      });
      return comment;
    });
  }

  async getPdfFormState(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<DrivePdfFormStateRecord | null> {
    await requirePdfObjectAccess(this.sql, input.orgId, input.actorId, input.objectId);
    const rows = (await this.sql`
      with latest_version as (
        select version_number, sha256, byte_size
        from drive_versions
        where org_id = ${input.orgId}
          and object_id = ${input.objectId}
        order by version_number desc
        limit 1
      )
      select
        s.*,
        latest_version.version_number as current_source_version_number,
        latest_version.sha256 as current_source_sha256,
        latest_version.byte_size as current_source_byte_size
      from drive_pdf_form_states s
      left join latest_version on true
      where s.org_id = ${input.orgId}
        and s.object_id = ${input.objectId}
        and s.actor_id = ${input.actorId}
      limit 1
    `) as unknown as readonly DrivePdfFormStateRow[];
    const row = rows[0];
    return row === undefined ? null : mapDrivePdfFormState(row);
  }

  async savePdfFormState(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly fieldValues: readonly JsonObject[];
  }): Promise<DrivePdfFormStateRecord> {
    return this.sql.begin(async (tx) => {
      const object = await requirePdfObjectAccess(tx, input.orgId, input.actorId, input.objectId);
      const source = await pdfFormSourceMetadata(tx, object);
      const rows = (await tx`
        insert into drive_pdf_form_states
          (org_id, object_id, actor_id, field_values, source_version_number, source_sha256, source_byte_size)
        values (
          ${input.orgId},
          ${input.objectId},
          ${input.actorId},
          ${tx.json(toSqlJson(input.fieldValues))},
          ${source.versionNumber},
          ${source.sha256},
          ${source.byteSize}
        )
        on conflict (org_id, object_id, actor_id)
        do update set
          field_values = excluded.field_values,
          source_version_number = excluded.source_version_number,
          source_sha256 = excluded.source_sha256,
          source_byte_size = excluded.source_byte_size,
          updated_at = now()
        returning *
      `) as unknown as readonly DrivePdfFormStateRow[];
      const state = mapDrivePdfFormState(rows[0], source);
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.pdf_form_state.saved",
        objectId: input.objectId,
        payload: {
          fieldCount: input.fieldValues.length,
          sourceVersionNumber: source.versionNumber,
        },
      });
      return state;
    });
  }

  async clearPdfFormState(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      await requirePdfObjectAccess(tx, input.orgId, input.actorId, input.objectId);
      const rows = (await tx`
        delete from drive_pdf_form_states
        where org_id = ${input.orgId}
          and object_id = ${input.objectId}
          and actor_id = ${input.actorId}
        returning object_id
      `) as unknown as readonly { readonly object_id: string }[];
      const cleared = rows.length > 0;
      if (cleared) {
        await appendDriveActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "drive.pdf_form_state.cleared",
          objectId: input.objectId,
          payload: {},
        });
      }
      return cleared;
    });
  }

  async getDriveSearchRecord(fileId: string): Promise<DriveSearchRecord | null> {
    const rows = (await this.sql`
      with recursive target as (
        select *
        from objects
        where id = ${fileId}
          and kind = 'file'
        limit 1
      ),
      folder_path as (
        select f.id, f.parent_folder_id, array[f.name]::text[] as path
        from drive_folders f
        join target t on f.id::text = t.metadata->>'folderId'
        union all
        select f.id, f.parent_folder_id, array[f.name]::text[] || fp.path
        from drive_folders f
        join folder_path fp on fp.parent_folder_id = f.id
      )
      select
        t.*,
        a.display_name as owner_display_name,
        a.email as owner_email,
        coalesce(
          (select fp.path from folder_path fp where fp.parent_folder_id is null limit 1),
          array[]::text[]
        ) as folder_path
      from target t
      left join actors a on a.id = t.owner_actor_id and a.org_id = t.org_id
    `) as unknown as readonly DriveSearchProjectionRow[];
    return rows[0] === undefined ? null : mapDriveSearchRecord(rows[0]);
  }

  getDriveEnrichmentRecord(fileId: string): Promise<DriveSearchRecord | null> {
    return this.getDriveSearchRecord(fileId);
  }

  async recordDriveEnrichment(input: DriveEnrichmentWrite): Promise<void> {
    await this.sql`
      update objects
      set
        metadata = jsonb_set(
          metadata,
          '{enrichments}',
          coalesce(metadata->'enrichments', '{}'::jsonb) ||
            jsonb_build_object(${input.feature}::text, ${this.sql.json(toSqlJson(input.data))}::jsonb),
          true
        ),
        updated_at = now()
      where id = ${input.fileId}
        and kind = 'file'
    `;
  }

  async setDriveAutoTags(input: DriveAutoTagWrite): Promise<void> {
    const tags = uniqueStrings(input.tags);
    await this.sql`
      update objects
      set
        metadata = metadata || ${this.sql.json(
          toSqlJson({
            tags,
            autoTag: {
              source: input.source,
              tags,
              updatedAt: new Date().toISOString(),
            },
          }),
        )}::jsonb,
        updated_at = now()
      where id = ${input.fileId}
        and kind = 'file'
    `;
  }

  private async presignPutUrl(storageKey: string, mimeType: string): Promise<string | null> {
    return this.storage?.presignPutUrl === undefined
      ? null
      : this.storage.presignPutUrl(storageKey, {
          contentType: mimeType,
          expiresSeconds: 900,
        });
  }

  private async presignGetUrl(storageKey: string): Promise<string | undefined> {
    return this.storage?.presignGetUrl?.(storageKey, { expiresSeconds: 3600 });
  }

  private async generatePreview(input: {
    readonly orgId: string;
    readonly objectId: string;
    readonly name: string;
    readonly storageKey: string;
    readonly mimeType: string;
    readonly versionNumber: number;
    readonly inlineContent?: Uint8Array;
  }): Promise<{ readonly preview: DrivePreview } | Record<string, never>> {
    if (!isOfficeMime(input.mimeType)) {
      return {};
    }

    const converter = this.options.officePreviewConverter;
    if (converter === undefined || this.storage === undefined) {
      return {
        preview: unsupportedOfficePreview(
          input.mimeType,
          "Office preview conversion requires the LibreOffice preview service.",
        ),
      };
    }

    const content = input.inlineContent ?? (await this.readObjectBytes(input.storageKey));
    if (content === undefined) {
      return {
        preview: unsupportedOfficePreview(
          input.mimeType,
          "Office preview conversion could not read the uploaded object bytes.",
        ),
      };
    }

    try {
      const converted = await converter.convert({
        objectId: input.objectId,
        name: input.name,
        storageKey: input.storageKey,
        sourceMimeType: input.mimeType,
        content,
      });
      const previewStorageKey = officePreviewStorageKey(
        input.orgId,
        input.objectId,
        input.versionNumber,
      );
      await this.storage.put({
        key: previewStorageKey,
        body: converted.pdf,
        contentType: "application/pdf",
        metadata: { objectId: input.objectId, sourceStorageKey: input.storageKey },
      });
      const previewUrl = await this.presignGetUrl(previewStorageKey);
      return {
        preview: {
          kind: "pdf",
          status: "available",
          mimeType: "application/pdf",
          storageKey: previewStorageKey,
          ...(previewUrl === undefined ? {} : { url: previewUrl }),
          ...(converted.pageCount === undefined ? {} : { pageCount: converted.pageCount }),
          generatedAt: converted.generatedAt,
        },
      };
    } catch (error) {
      return {
        preview: unsupportedOfficePreview(
          input.mimeType,
          error instanceof Error ? error.message : "Office preview conversion failed.",
        ),
      };
    }
  }

  private async readObjectBytes(storageKey: string): Promise<Uint8Array | undefined> {
    const object = await this.storage?.get(storageKey);
    if (object === null || object === undefined) {
      return undefined;
    }
    return toUint8Array(object.body);
  }

  private async updateFileFolder(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly folderId?: string | null;
    readonly verb: string;
    readonly restore: boolean;
  }): Promise<DriveEntryRecord | null> {
    return this.sql.begin(async (tx) => {
      if (input.folderId !== undefined && input.folderId !== null) {
        await requireFolderAccess(tx, input.orgId, input.actorId, input.folderId);
      }
      const current = await requireObjectAccess(tx, input.orgId, input.actorId, input.objectId);
      const rows = (await tx`
        update objects
        set
          deleted_at = ${input.restore ? null : current.deleted_at},
          metadata = ${tx.json(
            toSqlJson({
              ...current.metadata,
              folderId: input.folderId ?? null,
            }),
          )},
          updated_at = now()
        where id = ${input.objectId}
          and org_id = ${input.orgId}
          and kind = 'file'
        returning *, (select max(version_number) from drive_versions v where v.object_id = objects.id) as version_number
      `) as unknown as readonly DriveSearchRow[];
      if (rows[0] !== undefined && input.restore) {
        await syncTargetDeletedAt(tx, input.orgId, input.objectId, "restore");
      }
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: input.verb,
        objectId: input.objectId,
        payload: { folderId: input.folderId ?? null },
      });
      return rows[0] === undefined ? null : mapObjectEntry(rows[0]);
    });
  }
}

async function requireObjectAccess(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  objectId: string,
): Promise<ObjectRow> {
  // Drive surfaces 'file' (uploaded files / app-created docs) and
  // 'recording' (meet recordings). Both go through the same /content
  // endpoint, the same permissions table, and the same readObjectBytes
  // path — only the kind differs.
  const rows = (await sql`
    select *
    from objects
    where id = ${objectId}
      and org_id = ${orgId}
      and kind in ('file', 'recording')
      and ${canReadObjectSql(sql, actorId)}
    limit 1
  `) as unknown as readonly ObjectRow[];
  const object = rows[0];
  if (object === undefined) {
    throw new Error(`Unknown or inaccessible Drive object: ${objectId}`);
  }
  return object;
}

async function requirePdfObjectAccess(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  objectId: string,
): Promise<ObjectRow> {
  const rows = (await sql`
    select *
    from objects
    where id = ${objectId}
      and org_id = ${orgId}
      and kind = 'file'
      and mime_type = 'application/pdf'
      and (
        objects.owner_actor_id = ${actorId}
        or exists (
          select 1 from permissions p
          where p.resource_type = 'object'
            and p.resource_id = objects.id
            and p.org_id = ${orgId}
            and p.actor_id = ${actorId}
            and (p.expires_at is null or p.expires_at > now())
        )
      )
    limit 1
  `) as unknown as readonly ObjectRow[];
  const object = rows[0];
  if (object === undefined) {
    throw new Error(`Unknown or inaccessible Drive PDF object: ${objectId}`);
  }
  return object;
}

async function requireFolderAccess(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  folderId: string,
): Promise<void> {
  const rows = (await sql`
    select id
    from drive_folders
    where id = ${folderId}
      and org_id = ${orgId}
      and deleted_at is null
      and ${canReadFolderSql(sql, actorId)}
    limit 1
  `) as unknown as readonly { readonly id: string }[];
  if (rows[0] === undefined) {
    throw new Error(`Unknown or inaccessible Drive folder: ${folderId}`);
  }
}

async function requireDriveCommentParent(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly objectId: string;
    readonly parentCommentId: string;
  },
): Promise<void> {
  const rows = (await sql`
    select id
    from drive_comments
    where id = ${input.parentCommentId}
      and org_id = ${input.orgId}
      and object_id = ${input.objectId}
    limit 1
  `) as unknown as readonly { readonly id: string }[];
  if (rows[0] === undefined) {
    throw new Error(`Unknown parent Drive comment: ${input.parentCommentId}`);
  }
}

function canReadObjectSql(sql: SqlLike, actorId: string): postgres.PendingQuery<postgres.Row[]> {
  return sql`
    (
      objects.owner_actor_id = ${actorId}
      or exists (
        select 1 from permissions p
        where p.resource_type = 'object'
          and p.resource_id = objects.id
          and p.actor_id = ${actorId}
          and (p.expires_at is null or p.expires_at > now())
      )
    )
  `;
}

async function syncTargetDeletedAt(
  sql: SqlLike,
  orgId: string,
  objectId: string,
  action: "restore" | "trash",
): Promise<void> {
  const deletedAt = action === "restore" ? null : new Date();
  const rows = (await sql`
    select metadata->>'app' as app from objects
    where id = ${objectId} and org_id = ${orgId}
  `) as unknown as readonly { readonly app: string | null }[];
  const app = rows[0]?.app ?? null;
  if (app === "docs") {
    await sql`update docs_documents set deleted_at = ${deletedAt}, updated_at = now()
              where id = ${objectId} and org_id = ${orgId}`;
  } else if (app === "sheets") {
    await sql`update sheets set deleted_at = ${deletedAt}, updated_at = now()
              where id = ${objectId} and org_id = ${orgId}`;
  } else if (app === "slides") {
    await sql`update slide_decks set deleted_at = ${deletedAt}, updated_at = now()
              where id = ${objectId} and org_id = ${orgId}`;
  }
}

function canReadFolderSql(sql: SqlLike, actorId: string): postgres.PendingQuery<postgres.Row[]> {
  return sql`
    (
      drive_folders.owner_actor_id = ${actorId}
      or exists (
        select 1 from permissions p
        where p.resource_type = 'drive_folder'
          and p.resource_id = drive_folders.id
          and p.actor_id = ${actorId}
          and (p.expires_at is null or p.expires_at > now())
      )
    )
  `;
}

async function grantFolderAccess(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId: string;
    readonly role: string;
    readonly grantedByActorId: string;
  },
): Promise<void> {
  await sql`
    insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
    values (${input.orgId}, ${input.actorId}, 'drive_folder', ${input.folderId}, ${input.role}, ${input.grantedByActorId})
    on conflict do nothing
  `;
}

async function appendDriveActivity(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly verb: string;
    readonly objectId: string;
    readonly payload: JsonObject;
  },
): Promise<void> {
  const previousRows = (await sql`
    select this_hash from activity
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
      objectType: "drive.object",
      objectId: input.objectId,
      metadata: input.payload,
      createdAt: createdAt.toISOString(),
    },
    prevHash,
  );
  await sql`
    insert into activity (org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash, created_at)
    values (${input.orgId}, ${input.actorId}, ${input.verb}, 'drive.object', ${input.objectId}, ${sql.json(toSqlJson(input.payload))}, ${prevHash}, ${thisHash}, ${createdAt})
  `;
  await sql`
    insert into outbox (subject, payload)
    values (${`activity.${input.verb}`}, ${sql.json(
      toSqlJson({
        orgId: input.orgId,
        actorId: input.actorId,
        objectId: input.objectId,
        ...input.payload,
      }),
    )})
  `;
}

async function notifyDriveCommentMentions(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly object: ObjectRow;
    readonly commentId: string;
    readonly parentCommentId: string | null;
    readonly anchor: JsonObject;
    readonly body: string;
    readonly metadata: JsonObject;
  },
): Promise<void> {
  const tokens = mentionTokensForComment(input.metadata, input.body);
  if (tokens.length === 0) {
    return;
  }
  const actorRows = (await sql`
    select id, display_name, email
    from actors
    where org_id = ${input.orgId}
      and disabled_at is null
      and type = 'user'
      and (
        id = ${input.object.owner_actor_id}
        or exists (
          select 1 from permissions p
          where p.org_id = ${input.orgId}
            and p.actor_id = actors.id
            and p.resource_type = 'object'
            and p.resource_id = ${input.object.id}
            and (p.expires_at is null or p.expires_at > now())
        )
      )
  `) as unknown as readonly {
    readonly id: string;
    readonly display_name: string;
    readonly email: string | null;
  }[];
  const recipients = mentionedActorIds({
    actors: actorRows,
    authorActorId: input.actorId,
    tokens,
  });
  if (recipients.length === 0) {
    return;
  }
  const authorName =
    actorRows.find((actor) => actor.id === input.actorId)?.display_name ?? "Someone";
  const title = driveObjectNotificationTitle(input.object);
  const app = stringMetadata(input.object.metadata, "app");
  for (const recipientId of recipients) {
    await insertNotification(sql, {
      orgId: input.orgId,
      actorId: recipientId,
      verb: "drive.comment.mention",
      objectType: "drive.object",
      objectId: input.object.id,
      summary: `${authorName} mentioned you in "${title}".`,
      body: input.body,
      payload: {
        objectId: input.object.id,
        commentId: input.commentId,
        ...(input.parentCommentId === null ? {} : { parentCommentId: input.parentCommentId }),
        anchor: input.anchor,
        mentionedByActorId: input.actorId,
        mentionsText: tokens,
        ...(app === undefined ? {} : { app }),
      },
    });
  }
}

function mentionTokensForComment(metadata: JsonObject, body: string): readonly string[] {
  const tokens = new Set<string>();
  for (const token of mentionTokensFromMetadata(metadata)) {
    tokens.add(token);
  }
  for (const token of mentionTokensFromText(body)) {
    tokens.add(token);
  }
  return [...tokens];
}

function mentionTokensFromMetadata(metadata: JsonObject): readonly string[] {
  const mentionsText = metadata.mentionsText;
  if (!Array.isArray(mentionsText)) {
    return [];
  }
  const tokens = new Set<string>();
  for (const value of mentionsText) {
    if (typeof value !== "string") {
      continue;
    }
    const token = normalizeMentionToken(value);
    if (token.length > 0) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

function mentionTokensFromText(value: string): readonly string[] {
  const tokens = new Set<string>();
  for (const match of value.matchAll(/(^|\s)@([\p{L}\p{N}](?:[\p{L}\p{N}._-]*[\p{L}\p{N}])?)/gu)) {
    const token = normalizeMentionToken(match[2] ?? "");
    if (token.length > 0) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

function mentionedActorIds(input: {
  readonly actors: readonly {
    readonly id: string;
    readonly display_name: string;
    readonly email: string | null;
  }[];
  readonly authorActorId: string;
  readonly tokens: readonly string[];
}): readonly string[] {
  const tokenSet = new Set(input.tokens.map(normalizeMentionToken));
  const ids: string[] = [];
  for (const actor of input.actors) {
    if (actor.id === input.authorActorId) {
      continue;
    }
    const aliases = actorMentionAliases(actor);
    if ([...tokenSet].some((token) => aliases.has(token))) {
      ids.push(actor.id);
    }
  }
  return ids;
}

function actorMentionAliases(actor: {
  readonly display_name: string;
  readonly email: string | null;
}): ReadonlySet<string> {
  const aliases = new Set<string>();
  const email = actor.email?.trim().toLowerCase();
  if (email !== undefined && email.length > 0) {
    aliases.add(email);
    aliases.add(email.split("@")[0] ?? email);
  }
  const displayName = actor.display_name.trim().toLowerCase();
  if (displayName.length > 0) {
    aliases.add(displayName);
    aliases.add(displayName.replace(/[^a-z0-9]+/gu, ""));
    const firstName = displayName.split(/\s+/u)[0];
    if (firstName !== undefined) {
      aliases.add(firstName);
    }
  }
  return aliases;
}

function normalizeMentionToken(value: string): string {
  return value.trim().replace(/^@/u, "").toLowerCase();
}

function driveObjectNotificationTitle(object: ObjectRow): string {
  return (
    stringMetadata(object.metadata, "title") ??
    stringMetadata(object.metadata, "name") ??
    stringMetadata(object.metadata, "filename") ??
    object.storage_key.split("/").at(-1) ??
    "Drive object"
  );
}

function mapUpload(row: ObjectRow | undefined): Omit<DriveUploadRecord, "uploadUrl"> {
  if (row === undefined) {
    throw new Error("Expected Drive object row.");
  }
  const metadata = row.metadata;
  return {
    objectId: row.id,
    orgId: row.org_id,
    ownerActorId: row.owner_actor_id ?? "",
    name: stringMetadata(metadata, "name") ?? row.storage_key,
    folderId: nullableStringMetadata(metadata, "folderId"),
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    status: stringMetadata(metadata, "status") ?? "ready",
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVersion(row: DriveVersionRow | undefined): DriveVersionRecord {
  if (row === undefined) {
    throw new Error("Expected Drive version row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    objectId: row.object_id,
    versionNumber: row.version_number,
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    metadata: row.metadata,
    createdByActorId: row.created_by_actor_id,
    createdAt: row.created_at,
  };
}

function mapFolderEntry(row: DriveFolderRow): DriveEntryRecord {
  return {
    id: row.id,
    type: "folder",
    name: row.name,
    folderId: row.parent_folder_id,
    ownerActorId: row.owner_actor_id,
    app: null,
    metadata: row.metadata,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function missingFolderRow(): DriveFolderRow {
  throw new Error("Expected Drive folder row.");
}

function mapObjectEntry(row: DriveSearchRow): DriveEntryRecord {
  return {
    id: row.id,
    type: "file",
    name: stringMetadata(row.metadata, "name") ?? row.storage_key,
    folderId: nullableStringMetadata(row.metadata, "folderId"),
    ownerActorId: row.owner_actor_id,
    app: stringMetadata(row.metadata, "app") ?? null,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    storageKey: row.storage_key,
    versionNumber: row.version_number ?? undefined,
    ...drivePreviewProperty(row.mime_type, row.metadata),
    metadata: row.metadata,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSearchHit(row: DriveSearchRow): DriveSearchHit {
  const name = stringMetadata(row.metadata, "name") ?? row.storage_key;
  return {
    objectId: row.id,
    name,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    folderId: nullableStringMetadata(row.metadata, "folderId"),
    preview: `${name} ${row.mime_type}`.slice(0, 240),
    ...driveSearchPreviewProperty(row.mime_type, row.metadata),
    updatedAt: row.updated_at,
  };
}

function mapDriveComment(row: DriveCommentRow | undefined): DriveCommentRecord {
  if (row === undefined) {
    throw new Error("Expected Drive comment row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    objectId: row.object_id,
    parentCommentId: row.parent_comment_id,
    actorId: row.actor_id,
    anchor: row.anchor,
    body: row.body,
    status: row.status,
    metadata: row.metadata,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDriveCommentListItem(row: DriveCommentProjectionRow): DriveCommentListItem {
  const comment = mapDriveComment(row);
  return {
    ...comment,
    ...(row.actor_id === null
      ? {}
      : {
          author: {
            id: row.actor_id,
            ...(row.actor_display_name === null ? {} : { displayName: row.actor_display_name }),
            ...(row.actor_email === null ? {} : { email: row.actor_email }),
          },
        }),
  };
}

async function pdfFormSourceMetadata(
  sql: SqlLike,
  object: ObjectRow,
): Promise<PdfFormSourceMetadata> {
  const rows = (await sql`
    select version_number, sha256, byte_size
    from drive_versions
    where org_id = ${object.org_id}
      and object_id = ${object.id}
    order by version_number desc
    limit 1
  `) as unknown as readonly {
    readonly version_number: number;
    readonly sha256: string;
    readonly byte_size: string | number;
  }[];
  const latest = rows[0];
  if (latest === undefined) {
    return {
      versionNumber: null,
      sha256: object.sha256,
      byteSize: numberFromDatabaseLike(object.byte_size),
    };
  }
  return {
    versionNumber: latest.version_number,
    sha256: latest.sha256,
    byteSize: numberFromDatabaseLike(latest.byte_size),
  };
}

function mapDrivePdfFormState(
  row: DrivePdfFormStateRow | undefined,
  currentSource?: PdfFormSourceMetadata,
): DrivePdfFormStateRecord {
  if (row === undefined) {
    throw new Error("Expected Drive PDF form state row.");
  }
  const currentVersionNumber =
    currentSource?.versionNumber ?? row.current_source_version_number ?? null;
  const currentSha256 = currentSource?.sha256 ?? row.current_source_sha256 ?? null;
  const currentByteSize =
    currentSource?.byteSize ?? numberFromNullableDatabaseLike(row.current_source_byte_size ?? null);
  return {
    orgId: row.org_id,
    objectId: row.object_id,
    actorId: row.actor_id,
    fieldValues: jsonObjectArray(row.field_values),
    sourceVersionNumber: row.source_version_number,
    sourceSha256: row.source_sha256,
    sourceByteSize: numberFromNullableDatabaseLike(row.source_byte_size),
    sourceChanged:
      (row.source_version_number !== null &&
        currentVersionNumber !== null &&
        row.source_version_number !== currentVersionNumber) ||
      (row.source_sha256 !== null &&
        currentSha256 !== null &&
        row.source_sha256 !== currentSha256) ||
      (row.source_byte_size !== null &&
        currentByteSize !== null &&
        numberFromDatabaseLike(row.source_byte_size) !== currentByteSize),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDriveSearchRecord(row: DriveSearchProjectionRow): DriveSearchRecord {
  const metadata = row.metadata;
  const name = stringMetadata(metadata, "name") ?? row.storage_key;
  const parentFolderId = nullableStringMetadata(metadata, "folderId");
  return {
    id: row.id,
    orgId: row.org_id,
    kind: "file",
    name,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    storageKey: row.storage_key,
    ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
    ...(parentFolderId === null ? {} : { parentFolderId }),
    path: [...row.folder_path, name],
    ...(row.owner_actor_id === null
      ? {}
      : {
          owner: {
            id: row.owner_actor_id,
            ...(row.owner_display_name === null ? {} : { displayName: row.owner_display_name }),
            ...(row.owner_email === null ? {} : { email: row.owner_email }),
          },
        }),
    ...metadataStringArrayProperty(metadata, "tags"),
    ...metadataStringProperty(metadata, "summary"),
    ...metadataStringProperty(metadata, "description"),
    ...metadataStringProperty(metadata, "textContent"),
    ...metadataClassificationProperty(metadata),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.deleted_at === null
      ? {}
      : { trashedAt: row.deleted_at.toISOString(), deletedAt: row.deleted_at.toISOString() }),
    metadata,
  };
}

function driveStorageKey(
  orgId: string,
  objectId: string,
  versionNumber: number,
  name: string,
): string {
  const safeName = name.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "upload";
  return `drive/${orgId}/${objectId}/v${String(versionNumber)}/${safeName}`;
}

function driveObjectMetadata(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function stringMetadata(metadata: JsonObject, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function nullableStringMetadata(metadata: JsonObject, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" ? value : null;
}

function metadataStringProperty(metadata: JsonObject, key: string): Record<string, string> {
  const value = metadata[key];
  return typeof value === "string" ? { [key]: value } : {};
}

function metadataStringArrayProperty(
  metadata: JsonObject,
  key: string,
): { readonly tags?: readonly string[] } {
  const value = metadata[key];
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")
    ? { tags: value }
    : {};
}

function metadataClassificationProperty(
  metadata: JsonObject,
): Pick<DriveSearchRecord, "classification"> {
  const value = metadata.classification;
  return value === "public" ||
    value === "standard" ||
    value === "confidential" ||
    value === "restricted"
    ? { classification: value }
    : {};
}

function drivePreviewProperty(
  mimeType: string,
  metadata: JsonObject,
): Pick<DriveEntryRecord, "preview"> {
  const preview = drivePreviewFromMetadata(mimeType, metadata);
  return preview === undefined ? {} : { preview };
}

function driveSearchPreviewProperty(
  mimeType: string,
  metadata: JsonObject,
): Pick<DriveSearchHit, "previewMetadata"> {
  const preview = drivePreviewFromMetadata(mimeType, metadata);
  return preview === undefined ? {} : { previewMetadata: preview };
}

function drivePreviewFromMetadata(
  mimeType: string,
  metadata: JsonObject,
): DrivePreview | undefined {
  const preview = metadata.preview;
  if (isJsonObject(preview)) {
    const kind = stringMetadata(preview, "kind");
    const status = stringMetadata(preview, "status");
    const text = stringMetadata(preview, "text");
    const url = stringMetadata(preview, "url") ?? stringMetadata(preview, "previewUrl");
    const storageKey = stringMetadata(preview, "storageKey");
    const blocker = stringMetadata(preview, "blocker");
    const generatedAt = stringMetadata(preview, "generatedAt");
    if (
      (kind === "text" ||
        kind === "image" ||
        kind === "pdf" ||
        kind === "office" ||
        kind === "unsupported") &&
      (status === "available" || status === "unsupported")
    ) {
      return {
        kind,
        status,
        mimeType: stringMetadata(preview, "mimeType") ?? mimeType,
        ...(text === undefined ? {} : { text }),
        ...(url === undefined ? {} : { url }),
        ...(storageKey === undefined ? {} : { storageKey }),
        ...numberPreviewProperty(preview, "pageCount"),
        ...numberPreviewProperty(preview, "width"),
        ...numberPreviewProperty(preview, "height"),
        ...(blocker === undefined ? {} : { blocker }),
        ...(generatedAt === undefined ? {} : { generatedAt }),
      };
    }
  }

  const previewText =
    stringMetadata(metadata, "previewText") ?? stringMetadata(metadata, "textContent");
  if (previewText !== undefined && isTextPreviewMime(mimeType)) {
    return { kind: "text", status: "available", mimeType, text: previewText };
  }

  const previewUrl =
    stringMetadata(metadata, "previewUrl") ?? stringMetadata(metadata, "contentUrl");
  if (previewUrl !== undefined && mimeType.startsWith("image/")) {
    return {
      kind: "image",
      status: "available",
      mimeType,
      url: previewUrl,
      ...numberPreviewProperty(metadata, "width"),
      ...numberPreviewProperty(metadata, "height"),
    };
  }
  if (previewUrl !== undefined && mimeType === "application/pdf") {
    return {
      kind: "pdf",
      status: "available",
      mimeType,
      url: previewUrl,
      ...numberPreviewProperty(metadata, "pageCount"),
    };
  }
  if (isOfficeMime(mimeType)) {
    return unsupportedOfficePreview(
      mimeType,
      "Office preview conversion requires the LibreOffice preview service.",
    );
  }

  return undefined;
}

function unsupportedOfficePreview(mimeType: string, blocker: string): DrivePreview {
  return {
    kind: "office",
    status: "unsupported",
    mimeType,
    blocker,
  };
}

function isTextPreviewMime(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml"
  );
}

function isOfficeMime(mimeType: string): boolean {
  return [
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ].includes(mimeType);
}

function numberPreviewProperty(
  metadata: JsonObject,
  key: "height" | "pageCount" | "width",
): Partial<Pick<DrivePreview, "height" | "pageCount" | "width">> {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? { [key]: value } : {};
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function toUint8Array(body: AsyncIterable<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return body;
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      output.push(trimmed);
    }
  }
  return output;
}

function toSqlJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function numberFromDatabaseLike(value: string | number): number {
  return typeof value === "number" ? value : Number.parseInt(value, 10);
}

function numberFromNullableDatabaseLike(value: string | number | null): number | null {
  return value === null ? null : numberFromDatabaseLike(value);
}

function jsonObjectArray(value: unknown): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const output: JsonObject[] = [];
  for (const item of value) {
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      output.push(item as JsonObject);
    }
  }
  return output;
}
