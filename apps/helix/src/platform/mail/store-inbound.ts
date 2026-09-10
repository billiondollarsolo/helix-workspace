import type { JsonObject, StorageObject } from "@helix/sdk-types";
import type postgres from "postgres";
import { MailRawSourceIntegrityError } from "./errors.js";
import { MAIL_RAW_SOURCE_MAX_BYTES, verifyMailRawSource } from "./raw-source.js";
import { type PostgresMailStoreOptions } from "./store-contracts.js";
import {
  type SqlLike,
  deliverInboundMessage,
  insertMailMessage,
  mailMailboxActorIds,
  stageInlineAttachments,
} from "./store-message-write.js";
import {
  normalizeMessageId,
  normalizeProviderDeliveryId,
  threadReferenceIds,
} from "./threading.js";
import type { MailMessageInput, MailRawSourceRecord, StoredMailMessage } from "./types.js";

interface MailRawSourceRow {
  readonly message_id: string;
  readonly parser: string;
  readonly projection_version: number;
  readonly projection: JsonObject;
  readonly projection_sha256: string;
  readonly storage_key: string;
  readonly byte_size: number;
  readonly sha256: string;
}

interface MailIdentityRow {
  readonly message_id: string;
  readonly thread_id: string;
  readonly raw_sha256: string | null;
  readonly provider_delivery_id: string | null;
  readonly attachment_object_ids: readonly string[];
}

async function lockMailIdentities(
  sql: SqlLike,
  orgId: string,
  identityKeys: readonly string[],
): Promise<void> {
  await sql`
    select pg_advisory_xact_lock(hashtextextended(identity_key, 0))
    from (
      select unnest(${sql.array(identityKeys.map((key) => `${orgId}:${key}`))}::text[]) as identity_key
      order by identity_key
    ) ordered_identities
  `;
}

async function findInboundIdentity(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly normalizedMessageId: string | null;
    readonly rawSha256: string | null;
    readonly providerDeliveryId: string | null;
  },
): Promise<readonly MailIdentityRow[]> {
  return sql<MailIdentityRow[]>`
    select
      identity.message_id,
      messages.thread_id,
      identity.raw_sha256,
      identity.provider_delivery_id,
      coalesce(
        array_agg(attachments.object_id::text) filter (where attachments.object_id is not null),
        array[]::text[]
      ) as attachment_object_ids
    from mail_message_identities identity
    join messages
      on messages.id = identity.message_id
     and messages.org_id = identity.org_id
     and messages.kind = 'mail'
    left join message_attachments attachments on attachments.message_id = messages.id
    where identity.org_id = ${input.orgId}
      and (
        identity.normalized_message_id = ${input.normalizedMessageId ?? ""}
        or identity.raw_sha256 = ${input.rawSha256 ?? ""}
        or identity.provider_delivery_id = ${input.providerDeliveryId ?? ""}
      )
    group by
      identity.message_id,
      messages.thread_id,
      identity.raw_sha256,
      identity.provider_delivery_id
    order by identity.message_id
  `;
}

function resolveCanonicalIdentity(
  rows: readonly MailIdentityRow[],
  rawSha256: string | null,
  providerDeliveryId: string | null,
): MailIdentityRow {
  const canonical = rows[0];
  if (
    canonical === undefined ||
    rows.some((row) => row.message_id !== canonical.message_id) ||
    !(
      (rawSha256 !== null && canonical.raw_sha256 === rawSha256) ||
      (providerDeliveryId !== null && canonical.provider_delivery_id === providerDeliveryId)
    )
  ) {
    throw new Error("Inbound mail identity collision.");
  }
  return canonical;
}

async function findReferencedThread(
  sql: SqlLike,
  input: MailMessageInput,
): Promise<string | undefined> {
  if (input.threadId !== undefined) {
    return input.threadId;
  }
  const references = threadReferenceIds(input);
  const mailboxActorIds = mailMailboxActorIds(input);
  if (references.length === 0 || mailboxActorIds.length === 0) {
    return undefined;
  }
  const rows = await sql<{ readonly thread_id: string }[]>`
    select messages.thread_id
    from mail_message_identities identity
    join messages
      on messages.id = identity.message_id
     and messages.org_id = identity.org_id
     and messages.kind = 'mail'
    where identity.org_id = ${input.orgId}
      and identity.normalized_message_id = any(${sql.array([...references])}::text[])
      and (
        select count(*)
        from mail_thread_state mailbox
        where mailbox.org_id = ${input.orgId}
          and mailbox.thread_id = messages.thread_id
          and mailbox.actor_id = any(${sql.array([...mailboxActorIds])}::uuid[])
      ) = ${mailboxActorIds.length}
    order by
      array_position(${sql.array([...references])}::text[], identity.normalized_message_id),
      messages.sent_at desc,
      messages.id
    limit 1
  `;
  return rows[0]?.thread_id;
}

async function boundedStorageBody(
  body: StorageObject["body"],
  expectedSize: number,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 0 ||
    expectedSize > MAIL_RAW_SOURCE_MAX_BYTES
  ) {
    throw new MailRawSourceIntegrityError();
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength !== expectedSize) {
      throw new MailRawSourceIntegrityError();
    }
    return Buffer.from(body);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > expectedSize) {
      throw new MailRawSourceIntegrityError();
    }
    chunks.push(chunk);
  }
  if (total !== expectedSize) {
    throw new MailRawSourceIntegrityError();
  }
  return Buffer.concat(chunks);
}
export class MailInboundStore {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly options: PostgresMailStoreOptions = {},
  ) {}

  async insertInboundMessage(input: MailMessageInput): Promise<StoredMailMessage> {
    const inbound = {
      ...input,
      metadata: { ...(input.metadata ?? {}), direction: "inbound" },
    } satisfies MailMessageInput;
    if (input.rawSource !== undefined) {
      await verifyMailRawSource(input.rawSource);
    }
    const normalizedMessageId = normalizeMessageId(input.messageId);
    const providerDeliveryId = normalizeProviderDeliveryId(input.providerDeliveryId);
    if (input.providerDeliveryId !== undefined && providerDeliveryId === null) {
      throw new TypeError("providerDeliveryId must be a bounded, non-empty opaque identifier.");
    }
    const rawSha256 = input.rawSource?.sha256 ?? null;
    const identityKeys = [
      ...(normalizedMessageId === null ? [] : [`rfc:${normalizedMessageId}`]),
      ...(rawSha256 === null ? [] : [`raw:${rawSha256}`]),
      ...(providerDeliveryId === null ? [] : [`provider:${providerDeliveryId}`]),
    ].sort();

    const staged = await stageInlineAttachments(inbound, this.options.attachmentIngestor);
    try {
      const result = await this.sql.begin(async (tx) => {
        if (identityKeys.length > 0) {
          await lockMailIdentities(tx, input.orgId, identityKeys);
          const existing = await findInboundIdentity(tx, {
            orgId: input.orgId,
            normalizedMessageId,
            rawSha256,
            providerDeliveryId,
          });
          if (existing.length > 0) {
            const canonical = resolveCanonicalIdentity(existing, rawSha256, providerDeliveryId);
            const deliveredActorIds = await deliverInboundMessage(tx, {
              input: staged.input,
              threadId: canonical.thread_id,
              messageId: canonical.message_id,
            });
            return {
              threadId: canonical.thread_id,
              messageId: canonical.message_id,
              attachmentObjectIds: canonical.attachment_object_ids,
              created: false,
              deliveredActorIds,
              authoritativeAttachments: [],
            };
          }
        }

        const referencedThreadId = await findReferencedThread(tx, staged.input);
        const sourceStorage =
          input.rawSource === undefined
            ? undefined
            : (await this.options.storageResolver?.({ orgId: input.orgId }))?.client;
        if (input.rawSource !== undefined && sourceStorage === undefined) {
          throw new Error("Tenant storage is required for inbound mail evidence.");
        }
        return insertMailMessage(
          tx,
          referencedThreadId === undefined
            ? staged.input
            : { ...staged.input, threadId: referencedThreadId },
          sourceStorage,
        );
      });
      if (!result.created) {
        await this.options.attachmentIngestor?.release(staged.stages).catch(() => undefined);
      }
      const { authoritativeAttachments: _attachments, ...stored } = result;
      return stored;
    } catch (error) {
      await this.options.attachmentIngestor?.release(staged.stages).catch(() => undefined);
      throw error;
    }
  }

  async readRawSource(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly messageId: string;
  }): Promise<MailRawSourceRecord | null> {
    const rows = await this.sql<MailRawSourceRow[]>`
      select
        source.message_id,
        source.parser,
        source.projection_version,
        source.projection,
        source.projection_sha256,
        objects.storage_key,
        objects.byte_size,
        objects.sha256
      from mail_raw_sources source
      join messages on messages.id = source.message_id and messages.org_id = source.org_id
      join objects on objects.id = source.object_id and objects.org_id = source.org_id
      join mail_message_deliveries mailbox
        on mailbox.message_id = messages.id
       and mailbox.org_id = source.org_id
       and mailbox.actor_id = ${input.actorId}
      where source.org_id = ${input.orgId}
        and source.message_id = ${input.messageId}
        and objects.kind = 'mail_source'
        and objects.deleted_at is null
      limit 1
    `;
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const storage = (await this.options.storageResolver?.({ orgId: input.orgId }))?.client;
    if (storage === undefined) {
      throw new Error("Tenant storage is required for inbound mail evidence.");
    }
    const object = await storage.get(row.storage_key);
    if (object === null || object.key !== row.storage_key) {
      throw new MailRawSourceIntegrityError();
    }
    const bytes = await boundedStorageBody(object.body, row.byte_size);
    const source: MailRawSourceRecord = {
      messageId: row.message_id,
      bytes,
      byteSize: row.byte_size,
      sha256: row.sha256,
      parser: row.parser,
      projectionVersion: row.projection_version,
      projection: row.projection,
      projectionSha256: row.projection_sha256,
    };
    await verifyMailRawSource(source);
    return source;
  }
}
