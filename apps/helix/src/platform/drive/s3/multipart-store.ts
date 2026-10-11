import type { JsonObject } from "@helix/sdk-types";
import type postgres from "postgres";
import { toSqlJson } from "../../util/sql.js";

/** Gateway multipart sessions; parts are staged bytes in the tenant object store. */
export interface DriveS3MultipartUpload {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly accessKeyId: string;
  readonly bucket: string;
  readonly objectKey: string;
  readonly contentType: string;
  readonly userMetadata: Readonly<Record<string, string>>;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface DriveS3MultipartPart {
  readonly partNumber: number;
  readonly storageKey: string;
  readonly byteSize: number;
  readonly md5: string;
  readonly createdAt: Date;
}

export interface DriveS3MultipartStore {
  create(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly accessKeyId: string;
    readonly bucket: string;
    readonly objectKey: string;
    readonly contentType: string;
    readonly userMetadata: Readonly<Record<string, string>>;
    readonly expiresAt: Date;
  }): Promise<DriveS3MultipartUpload>;
  /** The actor's live upload, or null (unknown, expired, or someone else's). */
  find(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly uploadId: string;
  }): Promise<DriveS3MultipartUpload | null>;
  listUploads(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly bucket: string;
    readonly prefix: string;
  }): Promise<readonly DriveS3MultipartUpload[]>;
  /** Records a part; returns the storage key it replaced, if any. */
  putPart(input: {
    readonly orgId: string;
    readonly uploadId: string;
    readonly partNumber: number;
    readonly storageKey: string;
    readonly byteSize: number;
    readonly md5: string;
  }): Promise<string | null>;
  listParts(input: {
    readonly orgId: string;
    readonly uploadId: string;
  }): Promise<readonly DriveS3MultipartPart[]>;
  /** Deletes the session and its part rows; returns the staged keys to remove. */
  remove(input: { readonly orgId: string; readonly uploadId: string }): Promise<readonly string[]>;
  /** The actor's unexpired uploads. */
  countOpen(input: { readonly orgId: string; readonly actorId: string }): Promise<number>;
  /** Bytes already staged for an upload, excluding one part number (being replaced). */
  stagedBytes(input: {
    readonly orgId: string;
    readonly uploadId: string;
    readonly excludingPart: number;
  }): Promise<number>;
  /** Removes one part row; returns its staged key so the bytes can be deleted. */
  removePart(input: {
    readonly orgId: string;
    readonly uploadId: string;
    readonly partNumber: number;
  }): Promise<readonly string[]>;
  /** Expired sessions for the cleanup worker. */
  listExpired(input: {
    readonly orgId: string;
    readonly limit: number;
  }): Promise<readonly string[]>;
}

interface UploadRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_id: string;
  readonly access_key_id: string;
  readonly bucket: string;
  readonly object_key: string;
  readonly content_type: string;
  readonly user_metadata: JsonObject;
  readonly created_at: Date;
  readonly expires_at: Date;
}

interface PartRow {
  readonly part_number: number;
  readonly storage_key: string;
  readonly byte_size: string | number;
  readonly md5: string;
  readonly created_at: Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export class PostgresDriveS3MultipartStore implements DriveS3MultipartStore {
  constructor(private readonly sql: postgres.Sql) {}

  async create(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly accessKeyId: string;
    readonly bucket: string;
    readonly objectKey: string;
    readonly contentType: string;
    readonly userMetadata: Readonly<Record<string, string>>;
    readonly expiresAt: Date;
  }): Promise<DriveS3MultipartUpload> {
    const rows = await this.sql<UploadRow[]>`
      insert into drive_s3_multipart_uploads (
        org_id, actor_id, access_key_id, bucket, object_key, content_type, user_metadata, expires_at
      ) values (
        ${input.orgId}, ${input.actorId}, ${input.accessKeyId}, ${input.bucket}, ${input.objectKey},
        ${input.contentType}, ${this.sql.json(toSqlJson({ ...input.userMetadata }))}, ${input.expiresAt}
      )
      returning *
    `;
    const row = rows[0];
    if (row === undefined) throw new Error("Failed to create the multipart upload.");
    return mapUpload(row);
  }

  async find(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly uploadId: string;
  }): Promise<DriveS3MultipartUpload | null> {
    if (!UUID_RE.test(input.uploadId)) return null;
    const rows = await this.sql<UploadRow[]>`
      select * from drive_s3_multipart_uploads
      where org_id = ${input.orgId} and id = ${input.uploadId} and actor_id = ${input.actorId}
        and expires_at > now()
    `;
    return rows[0] === undefined ? null : mapUpload(rows[0]);
  }

  async listUploads(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly bucket: string;
    readonly prefix: string;
  }): Promise<readonly DriveS3MultipartUpload[]> {
    const rows = await this.sql<UploadRow[]>`
      select * from drive_s3_multipart_uploads
      where org_id = ${input.orgId} and actor_id = ${input.actorId} and bucket = ${input.bucket}
        and starts_with(object_key, ${input.prefix}) and expires_at > now()
      order by object_key, created_at
      limit 1000
    `;
    return rows.map(mapUpload);
  }

  async putPart(input: {
    readonly orgId: string;
    readonly uploadId: string;
    readonly partNumber: number;
    readonly storageKey: string;
    readonly byteSize: number;
    readonly md5: string;
  }): Promise<string | null> {
    const previous = await this.sql<{ readonly storage_key: string }[]>`
      select storage_key from drive_s3_multipart_parts
      where org_id = ${input.orgId} and upload_id = ${input.uploadId}
        and part_number = ${input.partNumber}
    `;
    await this.sql`
      insert into drive_s3_multipart_parts (
        org_id, upload_id, part_number, storage_key, byte_size, md5
      ) values (
        ${input.orgId}, ${input.uploadId}, ${input.partNumber}, ${input.storageKey},
        ${input.byteSize}, ${input.md5}
      )
      on conflict (upload_id, part_number) do update
      set storage_key = excluded.storage_key, byte_size = excluded.byte_size,
        md5 = excluded.md5, created_at = now()
    `;
    const replaced = previous[0]?.storage_key;
    return replaced === undefined || replaced === input.storageKey ? null : replaced;
  }

  async listParts(input: {
    readonly orgId: string;
    readonly uploadId: string;
  }): Promise<readonly DriveS3MultipartPart[]> {
    const rows = await this.sql<PartRow[]>`
      select part_number, storage_key, byte_size, md5, created_at
      from drive_s3_multipart_parts
      where org_id = ${input.orgId} and upload_id = ${input.uploadId}
      order by part_number
    `;
    return rows.map((row) => ({
      partNumber: row.part_number,
      storageKey: row.storage_key,
      byteSize: Number(row.byte_size),
      md5: row.md5,
      createdAt: row.created_at,
    }));
  }

  async remove(input: {
    readonly orgId: string;
    readonly uploadId: string;
  }): Promise<readonly string[]> {
    const parts = await this.sql<{ readonly storage_key: string }[]>`
      delete from drive_s3_multipart_parts
      where org_id = ${input.orgId} and upload_id = ${input.uploadId}
      returning storage_key
    `;
    await this.sql`
      delete from drive_s3_multipart_uploads
      where org_id = ${input.orgId} and id = ${input.uploadId}
    `;
    return parts.map((part) => part.storage_key);
  }

  async countOpen(input: { readonly orgId: string; readonly actorId: string }): Promise<number> {
    const rows = await this.sql<{ readonly count: number }[]>`
      select count(*)::int as count from drive_s3_multipart_uploads
      where org_id = ${input.orgId} and actor_id = ${input.actorId} and expires_at > now()
    `;
    return rows[0]?.count ?? 0;
  }

  async stagedBytes(input: {
    readonly orgId: string;
    readonly uploadId: string;
    readonly excludingPart: number;
  }): Promise<number> {
    const rows = await this.sql<{ readonly total: string }[]>`
      select coalesce(sum(byte_size), 0)::text as total from drive_s3_multipart_parts
      where org_id = ${input.orgId} and upload_id = ${input.uploadId}
        and part_number <> ${input.excludingPart}
    `;
    return Number(rows[0]?.total ?? 0);
  }

  async removePart(input: {
    readonly orgId: string;
    readonly uploadId: string;
    readonly partNumber: number;
  }): Promise<readonly string[]> {
    const rows = await this.sql<{ readonly storage_key: string }[]>`
      delete from drive_s3_multipart_parts
      where org_id = ${input.orgId} and upload_id = ${input.uploadId}
        and part_number = ${input.partNumber}
      returning storage_key
    `;
    return rows.map((row) => row.storage_key);
  }

  async listExpired(input: {
    readonly orgId: string;
    readonly limit: number;
  }): Promise<readonly string[]> {
    const rows = await this.sql<{ readonly id: string }[]>`
      select id from drive_s3_multipart_uploads
      where org_id = ${input.orgId} and expires_at <= now()
      order by expires_at
      limit ${input.limit}
    `;
    return rows.map((row) => row.id);
  }
}

function mapUpload(row: UploadRow): DriveS3MultipartUpload {
  const userMetadata: Record<string, string> = {};
  for (const [name, value] of Object.entries(row.user_metadata)) {
    if (typeof value === "string") userMetadata[name] = value;
  }
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    accessKeyId: row.access_key_id,
    bucket: row.bucket,
    objectKey: row.object_key,
    contentType: row.content_type,
    userMetadata,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}
