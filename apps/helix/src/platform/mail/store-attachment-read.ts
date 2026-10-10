import type postgres from "postgres";
import type { TenantStorageResolver } from "../storage/tenant-resolver.js";
import { MailAttachmentSizeError, MailDeliveryError } from "./errors.js";

export interface ReadMessageAttachmentInput {
  readonly orgId: string;
  readonly actorId: string;
  /** Internal message id that carries the attachment. */
  readonly messageId: string;
  readonly objectId: string;
  readonly maxBytes: number;
}

export interface MessageAttachmentContent {
  readonly content: Buffer;
  readonly mimeType: string;
  readonly filename?: string;
  readonly contentId?: string;
  readonly disposition: string;
}

interface AttachmentRow {
  readonly storage_key: string;
  readonly byte_size: string | number;
  readonly mime_type: string;
  readonly filename: string | null;
  readonly content_id: string | null;
  readonly disposition: string;
}

/**
 * Read the bytes of an attachment on a message the actor can see (sent by
 * them, or delivered to their mailbox). Mail-ingested objects must still carry
 * a clean, uncleaned antivirus stage. Returns null when not visible.
 */
export async function readVisibleMessageAttachment(
  sql: postgres.Sql,
  storageResolver: TenantStorageResolver | undefined,
  input: ReadMessageAttachmentInput,
): Promise<MessageAttachmentContent | null> {
  const rows = await sql<AttachmentRow[]>`
    select o.storage_key, o.byte_size, o.mime_type,
      o.metadata->>'filename' as filename, o.metadata->>'contentId' as content_id,
      ma.disposition
    from message_attachments ma
    join messages m on m.id = ma.message_id and m.org_id = ma.org_id
    join objects o on o.id = ma.object_id and o.org_id = ma.org_id
    where ma.org_id = ${input.orgId}
      and ma.message_id = ${input.messageId}
      and ma.object_id = ${input.objectId}
      and m.kind = 'mail' and m.deleted_at is null
      and o.deleted_at is null
      and o.kind in ('mail_attachment', 'file', 'recording')
      and (m.actor_id = ${input.actorId} or exists (
        select 1 from mail_message_deliveries delivery
        where delivery.org_id = ${input.orgId} and delivery.message_id = m.id
          and delivery.actor_id = ${input.actorId}
      ))
      and (o.kind <> 'mail_attachment' or exists (
        select 1 from mail_attachment_ingestions stage
        where stage.org_id = ${input.orgId} and stage.object_id = o.id
          and stage.status in ('clean', 'attached') and stage.cleaned_at is null
      ))
    limit 1
  `;
  const row = rows[0];
  if (row === undefined) return null;
  const byteSize = Number(row.byte_size);
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
    throw new MailDeliveryError("Mail attachment has an invalid stored size.", false);
  }
  if (byteSize > input.maxBytes) throw new MailAttachmentSizeError(input.maxBytes);
  const storage = (await storageResolver?.({ orgId: input.orgId }))?.client;
  if (storage === undefined) {
    throw new MailDeliveryError("Mail attachment storage is unavailable.", true);
  }
  const object = await storage.get(row.storage_key);
  if (object === null || object.key !== row.storage_key) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of object.body instanceof Uint8Array ? [object.body] : object.body) {
    total += chunk.byteLength;
    if (total > byteSize) throw new MailAttachmentSizeError(input.maxBytes);
    chunks.push(chunk);
  }
  return {
    content: Buffer.concat(chunks),
    mimeType: row.mime_type,
    ...(row.filename === null ? {} : { filename: row.filename }),
    ...(row.content_id === null ? {} : { contentId: row.content_id }),
    disposition: row.disposition,
  };
}
