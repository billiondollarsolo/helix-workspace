import {
  MAIL_ATTACHMENT_MAX_FILE_BYTES,
  MAIL_ATTACHMENT_MAX_FILES,
  MAIL_ATTACHMENT_MAX_TOTAL_BYTES,
} from "@helix/contracts";
import type { JsonObject } from "@helix/sdk-types";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import type { TenantStorageClient } from "../storage/tenant-resolver.js";
import { toSqlJson } from "../util/sql.js";
import type { StagedMailAttachment } from "./attachment-ingestion.js";
import { classifyMailCategory } from "./category.js";
import { MailAttachmentQuotaError, MailThreadNotFoundError } from "./errors.js";
import { type PostgresMailStoreOptions } from "./store-contracts.js";
import {
  normalizeMessageId,
  normalizeProviderDeliveryId,
  threadReferenceIds,
} from "./threading.js";
import type { MailAttachmentInput, MailMessageInput, StoredMailMessage } from "./types.js";

export type SqlLike = postgres.Sql | postgres.TransactionSql;

export async function deliverInboundMessage(
  sql: SqlLike,
  input: {
    readonly input: MailMessageInput;
    readonly threadId: string;
    readonly messageId: string;
  },
): Promise<readonly string[]> {
  const actorIds = mailMailboxActorIds(input.input);
  if (actorIds.length === 0) {
    throw new Error("Mail requires at least one mailbox owner.");
  }
  const rows = await sql<{ readonly actor_id: string }[]>`
    insert into mail_message_deliveries (org_id, message_id, actor_id, received_at)
    select ${input.input.orgId}, ${input.messageId}, actor_id,
      case when ${input.input.metadata?.direction === "outbound"} then null else now() end
    from unnest(${sql.array([...actorIds])}::uuid[]) as actor_id
    on conflict (message_id, actor_id) do update
    set received_at = excluded.received_at
    where mail_message_deliveries.received_at is null and excluded.received_at is not null
    returning actor_id
  `;
  const deliveredActorIds = rows.map((row) => row.actor_id);
  await writeMailboxStateAndEvents(sql, {
    input: input.input,
    threadId: input.threadId,
    messageId: input.messageId,
    actorIds: deliveredActorIds,
  });
  return deliveredActorIds;
}

async function writeMailboxStateAndEvents(
  sql: SqlLike,
  input: {
    readonly input: MailMessageInput;
    readonly threadId: string;
    readonly messageId: string;
    readonly actorIds: readonly string[];
  },
): Promise<void> {
  if (input.actorIds.length === 0) {
    return;
  }
  const category =
    input.input.metadata?.direction === "outbound"
      ? "primary"
      : classifyMailCategory({
          fromAddress: input.input.from.address,
          ...(input.input.from.name === undefined ? {} : { fromName: input.input.from.name }),
          subject: input.input.subject,
          hasListUnsubscribe: headerHasListUnsubscribe(input.input.metadata),
        });
  await sql`
    insert into mail_thread_state (actor_id, thread_id, org_id, category)
    select actor_id, ${input.threadId}, ${input.input.orgId}, ${category}
    from unnest(${sql.array([...input.actorIds])}::uuid[]) as actor_id
    on conflict (actor_id, thread_id) do update
    set category = excluded.category, updated_at = now()
  `;
  await sql`
    insert into outbox (subject, payload)
    select
      ${input.input.metadata?.direction === "outbound" ? "activity.mail.sent" : "activity.mail.received"},
      jsonb_build_object(
        'orgId', ${input.input.orgId}::text,
        'actorId', actor_id::text,
        'threadId', ${input.threadId}::text,
        'messageId', ${input.messageId}::text,
        'subject', ${input.input.subject}::text,
        'from', ${input.input.from.address}::text,
        'to', ${sql.json(toSqlJson(input.input.to.map((address) => address.address)))}::jsonb
      )
    from unnest(${sql.array([...input.actorIds])}::uuid[]) as actor_id
  `;
}

export function mailMailboxActorIds(input: MailMessageInput): readonly string[] {
  return [
    ...new Set(
      input.mailboxActorIds ??
        (input.actorId === undefined || input.actorId === null ? [] : [input.actorId]),
    ),
  ];
}

export async function stageInlineAttachments(
  input: MailMessageInput,
  ingestor: PostgresMailStoreOptions["attachmentIngestor"],
): Promise<{ readonly input: MailMessageInput; readonly stages: readonly StagedMailAttachment[] }> {
  const stages: StagedMailAttachment[] = [];
  try {
    const attachments = [];
    for (const attachment of input.attachments ?? []) {
      if (attachment.content === undefined) {
        attachments.push(attachment);
        continue;
      }
      if (ingestor === undefined) {
        throw new Error("Mail attachment ingestion is unavailable.");
      }
      const stage = await ingestor.stage({
        orgId: input.orgId,
        ...(input.actorId == null ? {} : { ownerActorId: input.actorId }),
        attachment: { ...attachment, content: attachment.content },
      });
      stages.push(stage);
      attachments.push(stage.attachment);
    }
    return {
      input: input.attachments === undefined ? input : { ...input, attachments },
      stages,
    };
  } catch (error) {
    await ingestor?.release(stages).catch(() => undefined);
    throw error;
  }
}

export async function insertMailMessage(
  sql: SqlLike,
  input: MailMessageInput,
  sourceStorage?: TenantStorageClient,
): Promise<
  StoredMailMessage & { readonly authoritativeAttachments: readonly MailAttachmentInput[] }
> {
  const mailboxActorIds = mailMailboxActorIds(input);
  if (mailboxActorIds.length === 0) {
    throw new Error("Mail requires at least one mailbox owner.");
  }
  const authoritativeAttachments = await authorizeMailAttachments(sql, input);
  const normalizedMessageId = normalizeMessageId(input.messageId);
  const providerDeliveryId = normalizeProviderDeliveryId(input.providerDeliveryId);
  const normalizedReferences = [...threadReferenceIds({ references: input.references })].reverse();
  const normalizedInReplyTo = normalizeMessageId(input.inReplyTo);
  const threadRows =
    input.threadId === undefined
      ? await sql<{ readonly id: string }[]>`
        insert into threads (org_id, kind, subject, created_by_actor_id, metadata)
        values (${input.orgId}, 'mail', ${input.subject}, ${input.actorId ?? null}, ${sql.json(toSqlJson({ messageId: normalizedMessageId }))})
        returning id
      `
      : await sql<{ readonly id: string }[]>`
        update threads
        set updated_at = now()
        where id = ${input.threadId} and org_id = ${input.orgId} and kind = 'mail'
        returning id
      `;
  const threadId = threadRows[0]?.id;
  if (threadId === undefined) {
    if (input.threadId !== undefined) throw new MailThreadNotFoundError(input.threadId);
    throw new Error("Unable to resolve mail thread.");
  }

  const metadata = {
    ...(input.metadata ?? {}),
    from: input.from,
    to: input.to,
    cc: input.cc ?? [],
    bcc: input.bcc ?? [],
    subject: input.subject,
    messageId: normalizedMessageId,
    inReplyTo: normalizedInReplyTo,
    references: normalizedReferences,
    ...(input.bodyHtml === undefined ? {} : { plainBody: input.bodyText }),
  } satisfies JsonObject;

  // Separate statements let RLS identity checks see the newly persisted message.
  const messageId = randomUUID();
  await sql`
    insert into messages (id, org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at)
    values (
      ${messageId}, ${input.orgId}, ${threadId}, ${input.actorId ?? null}, 'mail',
      ${input.bodyHtml ?? input.bodyText}, ${input.bodyHtml === undefined ? "plain" : "html"},
      ${sql.json(toSqlJson(metadata))}, ${input.receivedAt ?? new Date()}
    )
  `;
  if (
    normalizedMessageId !== null ||
    input.rawSource !== undefined ||
    providerDeliveryId !== null
  ) {
    await sql`
      insert into mail_message_identities (message_id, org_id, normalized_message_id, raw_sha256, provider_delivery_id)
      values (${messageId}, ${input.orgId}, ${normalizedMessageId}, ${input.rawSource?.sha256 ?? null}, ${providerDeliveryId})
    `;
  }

  if (input.rawSource !== undefined) {
    if (sourceStorage === undefined) {
      throw new Error("Tenant storage is required for inbound mail evidence.");
    }
    await persistRawSource(sql, input.orgId, messageId, input.rawSource, sourceStorage);
  }

  const objectIds: string[] = [];
  for (const attachment of authoritativeAttachments) {
    const objectId = attachment.objectId;
    if (objectId === undefined) throw new Error("Authorized mail attachment lost its object ID.");
    await sql`
      insert into message_attachments (org_id, message_id, object_id, disposition)
      values (${input.orgId}, ${messageId}, ${objectId}, ${attachment.disposition ?? "attachment"})
    `;
    objectIds.push(objectId);
  }

  const deliveredActorIds =
    input.metadata?.direction === "inbound"
      ? await deliverInboundMessage(sql, { input, threadId, messageId })
      : mailboxActorIds;
  if (input.metadata?.direction !== "inbound") {
    await writeMailboxStateAndEvents(sql, {
      input,
      threadId,
      messageId,
      actorIds: mailboxActorIds,
    });
  }
  await sql`select helix_record_mail_journal(${input.orgId}, ${messageId})`;

  return {
    threadId,
    messageId,
    attachmentObjectIds: objectIds,
    created: true,
    deliveredActorIds,
    authoritativeAttachments,
  };
}

async function authorizeMailAttachments(
  sql: SqlLike,
  input: MailMessageInput,
): Promise<readonly MailAttachmentInput[]> {
  const attachments = input.attachments ?? [];
  if (attachments.length > MAIL_ATTACHMENT_MAX_FILES) {
    throw new MailAttachmentQuotaError("Mail has too many attachments.");
  }
  const objectIds = attachments.map((attachment) => {
    if (attachment.objectId === undefined || attachment.content !== undefined) {
      throw new Error(`Mail attachment ${attachment.filename ?? "unnamed"} was not staged.`);
    }
    return attachment.objectId;
  });
  if (new Set(objectIds).size !== objectIds.length) {
    throw new MailAttachmentQuotaError("The same attachment cannot be added more than once.");
  }
  if (objectIds.length === 0) return attachments;
  const rows = await sql<
    {
      readonly id: string;
      readonly byte_size: string | number;
      readonly mime_type: string;
    }[]
  >`
    select objects.id, objects.byte_size, objects.mime_type
    from objects
    where objects.id = any(${objectIds})
      and objects.org_id = ${input.orgId}
      and objects.kind in ('file', 'recording', 'mail_attachment')
      and objects.deleted_at is null
      and (
        (objects.kind = 'mail_attachment' and exists (
          select 1 from mail_attachment_ingestions stage
          where stage.org_id = ${input.orgId} and stage.object_id = objects.id
            and stage.status = 'clean' and stage.cleaned_at is null
            and stage.owner_actor_id is not distinct from ${input.actorId ?? null}
        ))
        or (objects.kind in ('file', 'recording')
          and coalesce(objects.metadata->>'status', 'ready') = 'ready'
          and helix_drive_effective_role(${input.orgId}, ${input.actorId ?? null}, 'object', objects.id)
            in ('owner', 'editor', 'reader')
        )
      )
  `;
  const byId = new Map(rows.map((row) => [row.id, row]));
  let totalBytes = 0;
  const normalized = attachments.map((attachment, index) => {
    const objectId = objectIds[index] as string;
    const row = byId.get(objectId);
    if (row === undefined) throw new Error(`Unknown or inaccessible mail attachment: ${objectId}`);
    const byteSize = mailAttachmentByteSize(row.byte_size);
    if (byteSize > MAIL_ATTACHMENT_MAX_FILE_BYTES) {
      throw new MailAttachmentQuotaError("A mail attachment exceeds the 25 MiB per-file limit.");
    }
    totalBytes += byteSize;
    return { ...attachment, mimeType: row.mime_type, contentType: row.mime_type };
  });
  if (totalBytes > MAIL_ATTACHMENT_MAX_TOTAL_BYTES) {
    throw new MailAttachmentQuotaError("Mail attachments exceed the 25 MiB message limit.");
  }
  return normalized;
}

function mailAttachmentByteSize(value: string | number): number {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error("Mail attachment has invalid authoritative byte size.");
  }
  return bytes;
}

async function persistRawSource(
  sql: SqlLike,
  orgId: string,
  messageId: string,
  source: NonNullable<MailMessageInput["rawSource"]>,
  storage: TenantStorageClient,
): Promise<void> {
  const storageKey = `mail/sources/${messageId}/${source.sha256}.eml`;
  const objectRows = await sql<{ readonly id: string }[]>`
    insert into objects (
      org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata
    )
    values (
      ${orgId},
      null,
      'mail_source',
      ${storageKey},
      'message/rfc822',
      ${source.byteSize},
      ${source.sha256},
      ${sql.json(
        toSqlJson({
          messageId,
          parser: source.parser,
          projectionVersion: source.projectionVersion,
          projectionSha256: source.projectionSha256,
        }),
      )}
    )
    returning id
  `;
  const objectId = objectRows[0]?.id;
  if (objectId === undefined) {
    throw new Error("Unable to insert raw mail source object.");
  }
  await storage.put({
    key: storageKey,
    body: source.bytes,
    contentType: "message/rfc822",
    metadata: {
      objectId,
      messageId,
      sha256: source.sha256,
      parser: source.parser,
      projectionVersion: String(source.projectionVersion),
      projectionSha256: source.projectionSha256,
    },
  });
  await sql`
    insert into mail_raw_sources (
      message_id, org_id, object_id, parser, projection_version, projection, projection_sha256
    )
    values (
      ${messageId},
      ${orgId},
      ${objectId},
      ${source.parser},
      ${source.projectionVersion},
      ${sql.json(source.projection)},
      ${source.projectionSha256}
    )
  `;
}

/**
 * True when a message's metadata carries a `List-Unsubscribe` signal. The
 * ingest pipeline may surface this either as an explicit boolean flag or under
 * a parsed-headers map; absence is treated as "no signal".
 */
function headerHasListUnsubscribe(metadata: JsonObject | undefined): boolean {
  if (metadata === undefined) {
    return false;
  }
  if (metadata.hasListUnsubscribe === true || metadata.listUnsubscribe != null) {
    return true;
  }
  const headers = metadata.headers;
  if (headers !== null && typeof headers === "object" && !Array.isArray(headers)) {
    const record = headers as Record<string, unknown>;
    return Object.keys(record).some((key) => key.toLowerCase() === "list-unsubscribe");
  }
  return false;
}
