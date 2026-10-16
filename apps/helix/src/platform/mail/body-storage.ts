import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import type postgres from "postgres";
import { z } from "zod";
import { ApiError } from "../../api/api-error.js";
import type { TenantStorageClient, TenantStorageResolver } from "../storage/tenant-resolver.js";
import { withTenantIoSagaPostgresContext } from "../tenancy/postgres-roles.js";
import type { SqlLike } from "./store-message-write.js";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
export const MAIL_BODY_MAX_BYTES = 50 * 1024 * 1024;
const contentSchema = z
  .object({ version: z.literal(1), text: z.string(), html: z.string().optional() })
  .strict();
export type MailBodyContent = z.infer<typeof contentSchema>;

export interface StagedMailBody {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string | undefined;
  readonly storageKey: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly logicalSize: number;
}

function unavailable(cause?: unknown): ApiError {
  return new ApiError(
    "internal_error",
    "The stored email body could not be verified or loaded. Try again or contact an administrator.",
    {
      details: { mailCode: "mail.body_unavailable" },
      cause,
    },
  );
}

/** A durable cleanup intent precedes the upload; linking consumes it atomically. */
export async function stageMailBody(
  sql: postgres.Sql,
  resolver: TenantStorageResolver | undefined,
  orgId: string,
  content: Omit<MailBodyContent, "version">,
  actorId?: string,
): Promise<StagedMailBody | undefined> {
  // SQL-only fixtures and legacy importers can still write inline messages.
  if (resolver === undefined) return undefined;
  const storage = (await resolver({ orgId }))?.client;
  if (storage === undefined) throw unavailable();
  const raw = Buffer.from(JSON.stringify({ version: 1, ...content }));
  if (raw.byteLength > MAIL_BODY_MAX_BYTES)
    throw new RangeError("Email body exceeds the 50 MiB content limit.");
  const bytes = await compress(raw);
  const id = randomUUID();
  const stage = {
    id,
    orgId,
    actorId,
    storageKey: `mail/bodies/${id}.json.gz`,
    sha256: hash(bytes),
    byteSize: bytes.byteLength,
    logicalSize: raw.byteLength,
  };
  await withTenantIoSagaPostgresContext(
    sql,
    { orgId, ...(actorId === undefined ? { serviceContext: true } : { actorId }) },
    (tx) => tx`
    insert into drive_quarantine_deletions (org_id, object_id, storage_key, next_attempt_at)
    values (${orgId}, ${id}, ${stage.storageKey}, now() + interval '1 hour')
  `,
  );
  try {
    await storage.put({
      key: stage.storageKey,
      body: bytes,
      contentType: "application/gzip",
      metadata: { sha256: stage.sha256 },
    });
    await readStoredBody(storage, stage);
    return stage;
  } catch (error) {
    await releaseMailBody(sql, stage).catch(() => undefined);
    throw unavailable(error);
  }
}

export async function linkMailBody(
  sql: SqlLike,
  messageId: string,
  stage: StagedMailBody,
): Promise<void> {
  // A cleanup worker holding this intent wins over a late upload finalization.
  const intent = await sql`
    delete from drive_quarantine_deletions
    where org_id = ${stage.orgId} and storage_key = ${stage.storageKey} and status = 'pending'
    returning id
  `;
  if (intent.length !== 1) throw unavailable();
  await sql`
    insert into mail_message_bodies (org_id, message_id, storage_id, storage_key, sha256, byte_size, logical_size)
    values (${stage.orgId}, ${messageId}, ${stage.id}, ${stage.storageKey}, ${stage.sha256}, ${stage.byteSize}, ${stage.logicalSize})
  `;
}

export async function releaseMailBody(
  sql: postgres.Sql,
  stage: StagedMailBody | undefined,
): Promise<void> {
  if (stage === undefined) return;
  // Preserve committed content; a new job ID fences a cleanup already in flight.
  await withTenantIoSagaPostgresContext(
    sql,
    {
      orgId: stage.orgId,
      ...(stage.actorId === undefined ? { serviceContext: true } : { actorId: stage.actorId }),
    },
    (tx) => tx`
    insert into drive_quarantine_deletions (org_id, object_id, storage_key)
    select ${stage.orgId}, ${stage.id}, ${stage.storageKey}
    where not exists (select 1 from mail_message_bodies where org_id = ${stage.orgId} and storage_key = ${stage.storageKey})
    on conflict (org_id, storage_key) do update
    set id = gen_random_uuid(), status = 'pending', next_attempt_at = now(),
      lease_expires_at = null, completed_at = null, updated_at = now()
  `,
  );
}

/** Call only after the message/mailbox query has authorized this message. RLS also protects the reference. */
export async function readMailBody(
  sql: SqlLike,
  resolver: TenantStorageResolver | undefined,
  orgId: string,
  messageId: string,
): Promise<MailBodyContent> {
  const rows = await sql<
    {
      storage_key: string;
      sha256: string;
      byte_size: string | number;
      logical_size: string | number;
    }[]
  >`
    select storage_key, sha256, byte_size, logical_size from mail_message_bodies
    where org_id = ${orgId} and message_id = ${messageId}
  `;
  const row = rows[0];
  if (row === undefined || !/^mail\/bodies\/[a-f0-9-]{36}\.json\.gz$/u.test(row.storage_key))
    throw unavailable();
  const storage = (await resolver?.({ orgId }))?.client;
  if (storage === undefined) throw unavailable();
  try {
    return await readStoredBody(storage, {
      storageKey: row.storage_key,
      sha256: row.sha256,
      byteSize: Number(row.byte_size),
      logicalSize: Number(row.logical_size),
    });
  } catch (error) {
    throw unavailable(error);
  }
}

export async function readStoredBody(
  storage: TenantStorageClient,
  reference: Pick<StagedMailBody, "storageKey" | "sha256" | "byteSize" | "logicalSize">,
): Promise<MailBodyContent> {
  if (
    ![reference.byteSize, reference.logicalSize].every(
      (size) => Number.isSafeInteger(size) && size > 0 && size <= MAIL_BODY_MAX_BYTES,
    )
  )
    throw unavailable();
  const object = await storage.get(reference.storageKey);
  if (object === null || object.key !== reference.storageKey) throw unavailable();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const source = object.body instanceof Uint8Array ? [object.body] : object.body;
  for await (const chunk of source) {
    size += chunk.byteLength;
    if (size > reference.byteSize) throw unavailable();
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  if (size !== reference.byteSize || hash(bytes) !== reference.sha256) throw unavailable();
  const raw = await decompress(bytes, { maxOutputLength: reference.logicalSize });
  if (raw.byteLength !== reference.logicalSize) throw unavailable();
  return contentSchema.parse(JSON.parse(raw.toString("utf8")));
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
