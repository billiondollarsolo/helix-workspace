import { chatBodyFormatSchema, chatMetadataSchema } from "@helix/contracts";
import type { JsonObject } from "@helix/sdk-types";
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { ConflictError } from "../../api/api-error.js";
import { sensitivityClassificationFromMetadata } from "../ai/classification/index.js";
import { insertNotification } from "../notifications/index.js";
import { withTenantIoSagaPostgresContext } from "../tenancy/postgres-roles.js";
import { toSqlJson } from "../util/sql.js";
import { appendChatAudit } from "./audit.js";
import { requireActiveChatAttachments, requireChatActorInOrg } from "./authorization.js";
import {
  CHAT_PLATFORM_DEFAULT_DELETE_WINDOW_SECONDS,
  CHAT_PLATFORM_DEFAULT_EDIT_WINDOW_SECONDS,
  CHAT_PLATFORM_DEFAULT_RETENTION_DAYS,
  chatMutationAllowed,
} from "./compliance-policy.js";
import { normalizeChatContent, renderChatBodyHtml } from "./content-safety.js";
import { memberHandleResolver, parseMentions } from "./core/mentions.js";
import { ChatMemberAccessError, ChatMessageNotFoundError, ChatRoomAccessError } from "./errors.js";
import {
  canInviteChatGuest,
  canPostToChatSpace,
  chatGovernanceMetadata,
  readChatGovernance,
  shouldNotifyChatMember,
} from "./governance.js";
import type { ChatRoomEvent } from "./realtime.js";
import type {
  ChatEnrichmentProjectionStore,
  ChatEnrichmentRecord,
  ChatEnrichmentWrite,
  ChatExternalAccess,
  ChatHistoryPolicy,
  ChatInvitableRole,
  ChatMessageRecord,
  ChatNotificationPolicy,
  ChatOrganizationExportRecord,
  ChatPinRecord,
  ChatReactionMutationRecord,
  ChatReactionOperation,
  ChatReactionRecord,
  ChatReadReceiptRecord,
  ChatRetentionPolicyRecord,
  ChatRetentionPolicyView,
  ChatRoomExportRecord,
  ChatRoomKind,
  ChatRoomRecord,
  ChatRoomRole,
  ChatSearchHit,
  ChatSearchProjectionStore,
  ChatSearchReactionRecord,
  ChatSearchRecord,
  ChatSearchRequest,
  ChatSpaceType,
} from "./types.js";

export interface CreateChatRoomInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly kind?: ChatRoomKind | undefined;
  readonly subject?: string | undefined;
  readonly memberActorIds?: readonly string[] | undefined;
  readonly topic?: string | undefined;
  readonly privacy?: "discoverable" | "restricted" | "private" | undefined;
  readonly readReceiptsEnabled?: boolean | undefined;
  readonly spaceType?: Exclude<ChatSpaceType, "direct"> | undefined;
  readonly historyPolicy?: ChatHistoryPolicy | undefined;
  readonly retentionDays?: number | null | undefined;
  readonly legalHold?: boolean | undefined;
  readonly notificationPolicy?: ChatNotificationPolicy | undefined;
  readonly externalAccess?: ChatExternalAccess | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface SendChatMessageInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly roomId: string;
  readonly body: string;
  readonly bodyFormat?: string | undefined;
  readonly metadata?: JsonObject | undefined;
  readonly attachmentObjectIds?: readonly string[] | undefined;
  readonly parentMessageId?: string | undefined;
  readonly clientMessageId?: string | undefined;
  readonly suppressNotifications?: boolean | undefined;
}

export interface ChatMessageCursor {
  readonly sentAt: Date;
  readonly id: string;
}

export interface ChatStore {
  getRetentionPolicy?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId?: string | undefined;
  }): Promise<ChatRetentionPolicyView>;
  setRetentionPolicy?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId?: string | undefined;
    readonly retentionDays: number;
    readonly editWindowSeconds: number;
    readonly deleteWindowSeconds: number;
  }): Promise<ChatRetentionPolicyRecord>;
  setLegalHold?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId?: string | undefined;
    readonly enabled: boolean;
  }): Promise<ChatRetentionPolicyRecord>;
  exportOrganization?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomIds?: readonly string[] | undefined;
    readonly from?: Date | undefined;
    readonly to?: Date | undefined;
    readonly limit: number;
  }): Promise<ChatOrganizationExportRecord>;
  applyRetention?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly now?: Date | undefined;
    readonly limit?: number | undefined;
  }): Promise<{ readonly tombstonedMessageIds: readonly string[] }>;
  /** Runs long-lived realtime callbacks in a fresh transaction-local tenant context. */
  withActorContext?<T>(
    input: { readonly orgId: string; readonly actorId: string },
    callback: (store: ChatStore) => Promise<T>,
  ): Promise<T>;
  createRoom(input: CreateChatRoomInput): Promise<ChatRoomRecord>;
  listRooms(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly query?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly ChatRoomRecord[]>;
  discoverRooms(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly query?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly ChatRoomRecord[]>;
  joinRoom(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<ChatRoomRecord | null>;
  invite(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly actorIds: readonly string[];
    readonly role?: ChatInvitableRole | undefined;
  }): Promise<{ readonly roomId: string; readonly invitedActorIds: readonly string[] }>;
  removeMember?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly removedActorId: string;
  }): Promise<{ readonly roomId: string; readonly removedActorId: string; readonly removed: true }>;
  sendMessage(input: SendChatMessageInput): Promise<ChatMessageRecord>;
  listThreadReplies(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly parentMessageId: string;
    readonly before?: ChatMessageCursor | undefined;
    readonly direction?: "older" | "newer" | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly ChatMessageRecord[]>;
  pinMessage(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly messageId: string;
  }): Promise<ChatPinRecord>;
  unpinMessage(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly messageId: string;
  }): Promise<{ readonly ok: true }>;
  listPins(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<readonly ChatPinRecord[]>;
  react(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly messageId: string;
    readonly emoji: string;
    readonly op: ChatReactionOperation;
  }): Promise<ChatReactionMutationRecord>;
  editMessage(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly messageId: string;
    readonly body: string;
  }): Promise<ChatMessageRecord | null>;
  deleteMessage(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly messageId: string;
  }): Promise<ChatMessageRecord | null>;
  markRead(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly messageId: string;
  }): Promise<ChatReadReceiptRecord>;
  /**
   * Lists per-actor last-read markers for a room. Optional: stores that predate read
   * receipts may omit this; callers fall back to an empty roster.
   */
  listReadReceipts?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<readonly ChatReadReceiptRecord[]>;
  listMessages(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly before?: ChatMessageCursor | undefined;
    readonly direction?: "older" | "newer" | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly ChatMessageRecord[]>;
  exportRoom?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<ChatRoomExportRecord>;
  importMessages?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly messages: readonly {
      readonly sourceMessageId: string;
      readonly body: string;
      readonly bodyFormat: "plain" | "markdown";
      readonly sentAt?: string | undefined;
      readonly metadata: JsonObject;
    }[];
  }): Promise<{ readonly roomId: string; readonly messageIds: readonly string[] }>;
  search(input: ChatSearchRequest): Promise<readonly ChatSearchHit[]>;
  getRoomForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<ChatRoomRecord | null>;
  listPresenceBlockedActorIds?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly candidateActorIds: readonly string[];
  }): Promise<readonly string[]>;
}

interface ChatRoomRow {
  readonly id: string;
  readonly org_id: string;
  readonly kind: ChatRoomKind;
  readonly subject: string | null;
  readonly created_by_actor_id: string | null;
  readonly metadata: JsonObject;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly settings_thread_id: string | null;
  readonly settings_org_id: string | null;
  readonly settings_name: string | null;
  readonly settings_topic: string | null;
  readonly settings_privacy: "discoverable" | "restricted" | "private" | null;
  readonly settings_read_receipts_enabled: boolean | null;
  readonly settings_metadata: JsonObject | null;
  readonly settings_created_at: Date | null;
  readonly settings_updated_at: Date | null;
  readonly members: unknown;
}

interface ChatMessageRow {
  readonly id: string;
  readonly org_id: string;
  readonly thread_id: string;
  readonly actor_id: string | null;
  readonly body: string;
  readonly body_format: string;
  readonly client_message_id: string | null;
  readonly chat_revision?: number | string;
  readonly metadata: JsonObject;
  readonly attachment_object_ids: readonly string[] | null;
  readonly parent_message_id?: string | null;
  readonly sent_at: Date;
  readonly edited_at: Date | null;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface ChatMessageStateRow {
  readonly message_id: string;
  readonly reactions: readonly {
    readonly messageId: string;
    readonly actorId: string;
    readonly orgId: string;
    readonly emoji: string;
    readonly createdAt: string | Date;
  }[];
  readonly reply_count: number | string;
  readonly pin: {
    readonly roomId: string;
    readonly messageId: string;
    readonly orgId: string;
    readonly pinnedByActorId: string | null;
    readonly createdAt: string | Date;
  } | null;
  readonly attachments: readonly {
    readonly objectId: string;
    readonly source: "chat" | "drive";
    readonly filename: string;
    readonly mimeType: string;
    readonly byteSize: number | string;
  }[];
}

interface ChatPinRow {
  readonly thread_id: string;
  readonly message_id: string;
  readonly org_id: string;
  readonly pinned_by_actor_id: string | null;
  readonly created_at: Date;
}

interface ChatReactionRow {
  readonly message_id: string;
  readonly actor_id: string;
  readonly org_id: string;
  readonly emoji: string;
  readonly created_at: Date;
}

interface ChatReadReceiptRow {
  readonly thread_id: string;
  readonly actor_id: string;
  readonly org_id: string;
  readonly last_read_message_id: string | null;
  readonly last_read_at: Date;
  readonly updated_at: Date;
  readonly is_shared: boolean;
  readonly realtime_cursor?: number | string | null;
}

interface ChatSearchRow {
  readonly thread_id: string;
  readonly message_id: string;
  readonly actor_id: string | null;
  readonly subject: string | null;
  readonly body: string;
  readonly sent_at: Date;
}

interface ChatSearchRecordRow {
  readonly id: string;
  readonly org_id: string;
  readonly thread_id: string;
  readonly actor_id: string | null;
  readonly body: string;
  readonly metadata: JsonObject;
  readonly sent_at: Date;
  readonly edited_at: Date | null;
  readonly deleted_at: Date | null;
  readonly updated_at: Date;
  readonly room_subject: string | null;
  readonly room_kind: ChatRoomKind;
  readonly room_name: string | null;
  readonly room_acl_version: number | string;
  readonly allowed_actor_ids: readonly string[] | null;
  readonly actor_display_name: string | null;
  readonly actor_email: string | null;
}

type SqlLike = postgres.Sql | postgres.TransactionSql;

export class PostgresChatStore
  implements ChatStore, ChatSearchProjectionStore, ChatEnrichmentProjectionStore
{
  async getRetentionPolicy(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId?: string | undefined;
  }): Promise<ChatRetentionPolicyView> {
    await requireChatActorInOrg(this.sql, input.orgId, input.actorId);
    if (input.roomId !== undefined) {
      await requireChatRoomExistsInOrg(this.sql, input.orgId, input.roomId);
    }
    const rows =
      input.roomId === undefined
        ? await this.sql<readonly ChatRetentionPolicyRow[]>`
            select *
            from chat_retention_policies
            where org_id = ${input.orgId}
              and thread_id is null
            limit 1
          `
        : await this.sql<readonly ChatRetentionPolicyRow[]>`
            select *
            from chat_retention_policies
            where org_id = ${input.orgId}
              and thread_id = ${input.roomId}
            limit 1
          `;
    const row = rows[0];
    if (row === undefined) {
      return {
        orgId: input.orgId,
        roomId: input.roomId ?? null,
        retentionDays: CHAT_PLATFORM_DEFAULT_RETENTION_DAYS,
        editWindowSeconds: CHAT_PLATFORM_DEFAULT_EDIT_WINDOW_SECONDS,
        deleteWindowSeconds: CHAT_PLATFORM_DEFAULT_DELETE_WINDOW_SECONDS,
        legalHold: false,
        updatedAt: null,
        configured: false,
      };
    }
    const policy = mapRetentionPolicy(row);
    return {
      ...policy,
      updatedAt: policy.updatedAt,
      configured: true,
    };
  }

  async setRetentionPolicy(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId?: string | undefined;
    readonly retentionDays: number;
    readonly editWindowSeconds: number;
    readonly deleteWindowSeconds: number;
  }): Promise<ChatRetentionPolicyRecord> {
    return this.sql.begin(async (tx) => {
      await requireChatActorInOrg(tx, input.orgId, input.actorId);
      await lockChatCompliance(tx, input.orgId);
      if (input.roomId !== undefined) {
        await requireChatRoomExistsInOrg(tx, input.orgId, input.roomId);
      }
      const rows =
        input.roomId === undefined
          ? await tx<readonly ChatRetentionPolicyRow[]>`
              insert into chat_retention_policies (
                org_id, thread_id, retention_days, edit_window_seconds,
                delete_window_seconds, changed_by_actor_id
              )
              values (
                ${input.orgId}, null, ${input.retentionDays}, ${input.editWindowSeconds},
                ${input.deleteWindowSeconds}, ${input.actorId}
              )
              on conflict (org_id) where thread_id is null do update set
                retention_days = excluded.retention_days,
                edit_window_seconds = excluded.edit_window_seconds,
                delete_window_seconds = excluded.delete_window_seconds,
                changed_by_actor_id = excluded.changed_by_actor_id,
                updated_at = now()
              returning *
            `
          : await tx<readonly ChatRetentionPolicyRow[]>`
              insert into chat_retention_policies (
                org_id, thread_id, retention_days, edit_window_seconds,
                delete_window_seconds, changed_by_actor_id
              )
              values (
                ${input.orgId}, ${input.roomId}, ${input.retentionDays},
                ${input.editWindowSeconds}, ${input.deleteWindowSeconds}, ${input.actorId}
              )
              on conflict (org_id, thread_id) where thread_id is not null do update set
                retention_days = excluded.retention_days,
                edit_window_seconds = excluded.edit_window_seconds,
                delete_window_seconds = excluded.delete_window_seconds,
                changed_by_actor_id = excluded.changed_by_actor_id,
                updated_at = now()
              returning *
            `;
      const policy = mapRetentionPolicy(expectRetentionPolicy(rows[0]));
      await appendChatAudit(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "chat.retention.changed",
        objectType: "chat.room",
        objectId: input.roomId ?? input.orgId,
        metadata: {
          ...(input.roomId === undefined ? {} : { roomId: input.roomId }),
          retentionDays: input.retentionDays,
          editWindowSeconds: input.editWindowSeconds,
          deleteWindowSeconds: input.deleteWindowSeconds,
        },
      });
      return policy;
    });
  }

  async setLegalHold(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId?: string | undefined;
    readonly enabled: boolean;
  }): Promise<ChatRetentionPolicyRecord> {
    return this.sql.begin(async (tx) => {
      await requireChatActorInOrg(tx, input.orgId, input.actorId);
      await lockChatCompliance(tx, input.orgId);
      if (input.roomId !== undefined) {
        await requireChatRoomExistsInOrg(tx, input.orgId, input.roomId);
      }
      const rows =
        input.roomId === undefined
          ? await tx<readonly ChatRetentionPolicyRow[]>`
              insert into chat_retention_policies (
                org_id, thread_id, legal_hold, changed_by_actor_id
              )
              values (${input.orgId}, null, ${input.enabled}, ${input.actorId})
              on conflict (org_id) where thread_id is null do update set
                legal_hold = excluded.legal_hold,
                changed_by_actor_id = excluded.changed_by_actor_id,
                updated_at = now()
              returning *
            `
          : await tx<readonly ChatRetentionPolicyRow[]>`
              insert into chat_retention_policies (
                org_id, thread_id, legal_hold, changed_by_actor_id
              )
              values (${input.orgId}, ${input.roomId}, ${input.enabled}, ${input.actorId})
              on conflict (org_id, thread_id) where thread_id is not null do update set
                legal_hold = excluded.legal_hold,
                changed_by_actor_id = excluded.changed_by_actor_id,
                updated_at = now()
              returning *
            `;
      const policy = mapRetentionPolicy(expectRetentionPolicy(rows[0]));
      await appendChatAudit(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "chat.legal_hold.changed",
        objectType: "chat.room",
        objectId: input.roomId ?? input.orgId,
        metadata: {
          ...(input.roomId === undefined ? {} : { roomId: input.roomId }),
          legalHold: input.enabled,
        },
      });
      return policy;
    });
  }

  async exportOrganization(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomIds?: readonly string[] | undefined;
    readonly from?: Date | undefined;
    readonly to?: Date | undefined;
    readonly limit: number;
  }): Promise<ChatOrganizationExportRecord> {
    return this.sql.begin(async (tx) => {
      await requireChatActorInOrg(tx, input.orgId, input.actorId);
      const roomIds = [...new Set(input.roomIds ?? [])];
      if (roomIds.length > 0) {
        const roomRows = await tx<readonly { readonly id: string }[]>`
          select id from threads
          where org_id = ${input.orgId}
            and kind in ('chat_room', 'chat_dm')
            and id = any(${tx.array(roomIds)}::uuid[])
        `;
        if (roomRows.length !== roomIds.length) throw new ChatRoomAccessError();
      }
      const idRows = await tx<
        readonly {
          readonly id: string;
        }[]
      >`select gen_random_uuid()::text as id`;
      const exportId = idRows[0]?.id;
      if (exportId === undefined) throw new Error("Unable to allocate Chat export ID.");
      const rows = await tx<readonly ChatExportMessageRow[]>`
        select
          m.id, m.thread_id, m.actor_id,
          case when m.deleted_at is null then m.body else null end as body,
          case when m.deleted_at is null then m.body_format else 'plain' end as body_format,
          m.sent_at, m.edited_at, m.deleted_at
        from messages m
        join threads t on t.id = m.thread_id and t.org_id = m.org_id
        where m.org_id = ${input.orgId}
          and m.kind = 'chat'
          and (${roomIds.length === 0} or m.thread_id = any(${tx.array(roomIds)}::uuid[]))
          and (${input.from ?? null}::timestamptz is null or m.sent_at >= ${input.from ?? null})
          and (${input.to ?? null}::timestamptz is null or m.sent_at <= ${input.to ?? null})
        order by m.sent_at, m.id
        limit ${input.limit + 1}
      `;
      const truncated = rows.length > input.limit;
      const messages = rows.slice(0, input.limit).map(mapExportMessage);
      await appendChatAudit(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "chat.export.created",
        objectType: "chat.export",
        objectId: exportId,
        metadata: {
          exportId,
          roomIds,
          messageCount: messages.length,
          truncated,
          ...(input.from === undefined ? {} : { from: input.from.toISOString() }),
          ...(input.to === undefined ? {} : { to: input.to.toISOString() }),
        },
      });
      return {
        exportId,
        orgId: input.orgId,
        generatedAt: new Date(),
        messages,
        truncated,
      };
    });
  }

  async applyRetention(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly now?: Date | undefined;
    readonly limit?: number | undefined;
  }): Promise<{ readonly tombstonedMessageIds: readonly string[] }> {
    return this.sql.begin(async (tx) => {
      if (input.actorId !== "system") {
        await requireChatActorInOrg(tx, input.orgId, input.actorId);
      }
      await lockChatCompliance(tx, input.orgId);
      const now = input.now ?? new Date();
      const candidates = await tx<readonly { readonly id: string; readonly thread_id: string }[]>`
        select m.id, m.thread_id
        from messages m
        where m.org_id = ${input.orgId}
          and m.kind = 'chat'
          and m.deleted_at is null
          and not (
            coalesce((select (metadata->>'legalHold')::boolean from chat_room_settings where org_id = m.org_id and thread_id = m.thread_id), false)
            or coalesce(
              (select legal_hold from chat_retention_policies
               where org_id = m.org_id and thread_id = m.thread_id),
              false
            )
            or coalesce(
              (select legal_hold from chat_retention_policies
               where org_id = m.org_id and thread_id is null),
              false
            )
          )
          and m.sent_at < ${now} - make_interval(days => coalesce(
            (select (metadata->>'retentionDays')::integer from chat_room_settings where org_id = m.org_id and thread_id = m.thread_id),
            (select retention_days from chat_retention_policies
             where org_id = m.org_id and thread_id = m.thread_id),
            (select retention_days from chat_retention_policies
             where org_id = m.org_id and thread_id is null),
            2555
          ))
        order by m.sent_at, m.id
        limit ${input.limit ?? 500}
        for update skip locked
      `;
      const ids = candidates.map((candidate) => candidate.id);
      if (ids.length > 0) {
        await tx`delete from message_attachments where message_id = any(${tx.array(ids)}::uuid[])`;
        await tx`
          update messages
          set
            deleted_at = ${now},
            tombstoned_at = ${now},
            tombstone_reason = 'retention',
            updated_at = ${now}
          where org_id = ${input.orgId}
            and id = any(${tx.array(ids)}::uuid[])
        `;
        for (const candidate of candidates) {
          await appendChatAudit(tx, {
            orgId: input.orgId,
            actorId: input.actorId,
            verb: "chat.message.retention_deleted",
            objectType: "chat.message",
            objectId: candidate.id,
            metadata: {
              roomId: candidate.thread_id,
              messageId: candidate.id,
              reason: "retention",
            },
          });
        }
      }
      return { tombstonedMessageIds: ids };
    });
  }

  constructor(private readonly sql: postgres.Sql) {}

  withActorContext<T>(
    input: { readonly orgId: string; readonly actorId: string },
    callback: (store: ChatStore) => Promise<T>,
  ): Promise<T> {
    return withTenantIoSagaPostgresContext(this.sql, input, async (tx) =>
      callback(new PostgresChatStore(chatTransactionSql(tx))),
    );
  }

  async createRoom(input: CreateChatRoomInput): Promise<ChatRoomRecord> {
    return this.sql.begin(async (tx) => {
      const memberActorIds = [...new Set([input.actorId, ...(input.memberActorIds ?? [])])];
      await requireActiveOrgActors(tx, input.orgId, memberActorIds);
      const kind = input.kind ?? "chat_room";
      const governance = chatGovernanceMetadata(kind, {
        ...(input.spaceType === undefined ? {} : { spaceType: input.spaceType }),
        ...(input.historyPolicy === undefined ? {} : { historyPolicy: input.historyPolicy }),
        ...(input.retentionDays === undefined ? {} : { retentionDays: input.retentionDays }),
        ...(input.legalHold === undefined ? {} : { legalHold: input.legalHold }),
        ...(input.notificationPolicy === undefined
          ? {}
          : { notificationPolicy: input.notificationPolicy }),
        ...(input.externalAccess === undefined ? {} : { externalAccess: input.externalAccess }),
      });
      await requireAllowedExternalActors(
        tx,
        input.orgId,
        memberActorIds,
        readChatGovernance(kind, governance).externalAccess,
      );
      const participantKey = kind === "chat_dm" ? directParticipantKey(memberActorIds) : null;
      if (participantKey !== null) {
        if (memberActorIds.length < 2)
          throw new TypeError("A direct message needs two participants.");
        await tx`select pg_advisory_xact_lock(hashtextextended(${`${input.orgId}:${participantKey}`}, 0))`;
        const existing = await selectRoomByParticipantKey(
          tx,
          input.orgId,
          input.actorId,
          participantKey,
        );
        if (existing !== null) return existing;
      }
      const threadRows = await tx<{ readonly id: string }[]>`
        insert into threads (org_id, kind, subject, created_by_actor_id, metadata)
        values (
          ${input.orgId},
          ${kind},
          ${input.subject ?? null},
          ${input.actorId},
          ${tx.json(toSqlJson(input.metadata ?? {}))}
        )
        returning id
      `;
      const roomId = threadRows[0]?.id;
      if (roomId === undefined) {
        throw new Error("Unable to create chat room.");
      }

      await tx`
        insert into chat_room_settings (
          thread_id,
          org_id,
          name,
          topic,
          privacy,
          participant_key,
          read_receipts_enabled,
          metadata
        )
        values (
          ${roomId},
          ${input.orgId},
          ${input.subject ?? null},
          ${input.topic ?? null},
          ${kind === "chat_dm" ? "private" : (input.privacy ?? "restricted")},
          ${participantKey},
          ${input.readReceiptsEnabled ?? true},
          ${tx.json(toSqlJson(governance))}
        )
      `;

      await grantRoomAccess(tx, {
        orgId: input.orgId,
        roomId,
        actorId: input.actorId,
        role: "owner",
        grantedByActorId: input.actorId,
      });
      for (const memberActorId of memberActorIds) {
        if (memberActorId === input.actorId) continue;
        await grantRoomAccess(tx, {
          orgId: input.orgId,
          roomId,
          actorId: memberActorId,
          role: "member",
          grantedByActorId: input.actorId,
        });
      }

      await appendChatAudit(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "chat.room.created",
        objectType: "chat.room",
        objectId: roomId,
        metadata: { memberCount: memberActorIds.length },
      });
      return expectRoom(await selectRoomForActor(tx, input.orgId, input.actorId, roomId), roomId);
    });
  }

  async invite(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly actorIds: readonly string[];
    readonly role?: ChatInvitableRole | undefined;
  }): Promise<{ readonly roomId: string; readonly invitedActorIds: readonly string[] }> {
    const invitedActorIds = [...new Set(input.actorIds)];
    await this.sql.begin(async (tx) => {
      const room = await selectRoomForActor(tx, input.orgId, input.actorId, input.roomId);
      const inviterRole =
        room?.members.find(({ actorId }) => actorId === input.actorId)?.role ?? null;
      const role = input.role ?? "member";
      if (
        room?.kind === "chat_dm" ||
        inviterRole === null ||
        inviterRole === "member" ||
        (role === "moderator" && inviterRole !== "owner")
      ) {
        throw new ChatRoomAccessError(input.roomId);
      }
      await requireActiveOrgActors(tx, input.orgId, invitedActorIds);
      await requireAllowedExternalActors(
        tx,
        input.orgId,
        invitedActorIds,
        room?.settings?.externalAccess ?? "guests",
      );
      for (const invitedActorId of invitedActorIds) {
        await grantRoomAccess(tx, {
          orgId: input.orgId,
          roomId: input.roomId,
          actorId: invitedActorId,
          role,
          grantedByActorId: input.actorId,
        });
      }
      await appendChatAudit(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "chat.room.members_invited",
        objectType: "chat.room",
        objectId: input.roomId,
        metadata: { invitedActorIds, role },
      });
    });
    return { roomId: input.roomId, invitedActorIds };
  }

  async removeMember(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly removedActorId: string;
  }): Promise<{
    readonly roomId: string;
    readonly removedActorId: string;
    readonly removed: true;
  }> {
    return this.sql.begin(async (tx) => {
      await tx`
        select id from permissions
        where org_id = ${input.orgId} and resource_type = 'thread'
          and resource_id = ${input.roomId}
        order by id for update
      `;
      const room = await selectRoomForActor(tx, input.orgId, input.actorId, input.roomId);
      const callerRole = room?.members.find(({ actorId }) => actorId === input.actorId)?.role;
      const targetRole = room?.members.find(
        ({ actorId }) => actorId === input.removedActorId,
      )?.role;
      if (
        room?.kind !== "chat_room" ||
        (callerRole !== "owner" && callerRole !== "moderator") ||
        targetRole === undefined ||
        targetRole === "owner" ||
        (targetRole === "moderator" && callerRole !== "owner")
      ) {
        throw new ChatMemberAccessError();
      }
      // The permission trigger appends a durable access.changed event in this transaction.
      await tx`
        delete from permissions
        where org_id = ${input.orgId} and resource_type = 'thread'
          and resource_id = ${input.roomId} and actor_id = ${input.removedActorId}
      `;
      await appendChatAudit(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "chat.room.member_removed",
        objectType: "chat.room",
        objectId: input.roomId,
        metadata: { removedActorId: input.removedActorId },
      });
      return { roomId: input.roomId, removedActorId: input.removedActorId, removed: true };
    });
  }

  async listRooms(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly query?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly ChatRoomRecord[]> {
    const query = input.query ?? "";
    const rows = await this.sql<ChatRoomRow[]>`
      select
        t.*,
        s.thread_id as settings_thread_id,
        s.org_id as settings_org_id,
        s.name as settings_name,
        s.topic as settings_topic,
        s.privacy as settings_privacy,
        s.read_receipts_enabled as settings_read_receipts_enabled,
        s.metadata as settings_metadata,
        s.created_at as settings_created_at,
        s.updated_at as settings_updated_at,
        (
          select coalesce(
            jsonb_agg(
              jsonb_build_object(
                'actorId', p.actor_id::text,
                'role', p.role,
                'displayName', a.display_name,
                'email', a.email
              )
              order by a.display_name nulls last, p.actor_id::text
            ),
            '[]'::jsonb
          )
          from permissions p
          join actors a on a.id = p.actor_id and a.org_id = p.org_id
          where chat_permission_is_valid(p, ${input.orgId}, p.actor_id, t.id)
        ) as members
      from threads t
      left join chat_room_settings s on s.thread_id = t.id
      where t.org_id = ${input.orgId}
        and t.kind in ('chat_room', 'chat_dm')
        and (${query} = '' or coalesce(s.name, t.subject, '') ilike ${`%${query}%`} or coalesce(s.topic, '') ilike ${`%${query}%`})
        and exists (
          select 1 from permissions access_grant
          where chat_permission_is_valid(
            access_grant, ${input.orgId}, ${input.actorId}, t.id
          )
        )
      order by t.updated_at desc
      limit ${input.limit ?? 50}
    `;
    return rows.map(mapRoom);
  }

  async discoverRooms(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly query?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly ChatRoomRecord[]> {
    await requireActiveOrgActors(this.sql, input.orgId, [input.actorId]);
    const query = input.query ?? "";
    const rows = await this.sql<ChatRoomRow[]>`
      select
        t.*,
        s.thread_id as settings_thread_id,
        s.org_id as settings_org_id,
        s.name as settings_name,
        s.topic as settings_topic,
        s.privacy as settings_privacy,
        s.read_receipts_enabled as settings_read_receipts_enabled,
        s.metadata as settings_metadata,
        s.created_at as settings_created_at,
        s.updated_at as settings_updated_at,
        '[]'::jsonb as members
      from chat_room_settings s
      join threads t on t.id = s.thread_id and t.org_id = s.org_id
      where s.org_id = ${input.orgId}
        and t.kind = 'chat_room'
        and s.privacy in ('discoverable', 'restricted')
        and exists (
          select 1
          from actors requester
          left join organization_memberships membership
            on membership.org_id = requester.org_id
           and membership.actor_id = requester.id
           and membership.status = 'active'
          where requester.org_id = ${input.orgId}
            and requester.id = ${input.actorId}
            and requester.disabled_at is null
            and (
              requester.type <> 'user'
              or membership.guest_type = 'member'
              or (
                membership.guest_type = 'external'
                and coalesce(s.metadata->>'externalAccess', 'guests') <> 'internal'
              )
              or (
                membership.guest_type = 'partner'
                and coalesce(s.metadata->>'externalAccess', 'guests') = 'federated'
              )
            )
        )
        and (${query} = '' or coalesce(s.name, t.subject, '') ilike ${`%${query}%`} or coalesce(s.topic, '') ilike ${`%${query}%`})
      order by s.updated_at desc, s.thread_id
      limit ${input.limit ?? 50}
    `;
    return rows.map(mapRoom);
  }

  async joinRoom(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<ChatRoomRecord | null> {
    return this.sql.begin(async (tx) => {
      const current = await selectRoomForActor(tx, input.orgId, input.actorId, input.roomId);
      if (current !== null) return current;
      await requireActiveOrgActors(tx, input.orgId, [input.actorId]);
      const rows = await tx<{ readonly id: string; readonly metadata: JsonObject }[]>`
        select thread.id, settings.metadata
        from threads thread
        join chat_room_settings settings
          on settings.thread_id = thread.id and settings.org_id = thread.org_id
        where thread.id = ${input.roomId}
          and thread.org_id = ${input.orgId}
          and thread.kind = 'chat_room'
          and settings.privacy = 'discoverable'
        for update of settings
      `;
      const row = rows[0];
      if (row === undefined) return null;
      await requireAllowedExternalActors(
        tx,
        input.orgId,
        [input.actorId],
        readChatGovernance("chat_room", row.metadata).externalAccess,
      );
      await grantRoomAccess(tx, {
        orgId: input.orgId,
        roomId: input.roomId,
        actorId: input.actorId,
        role: "member",
        grantedByActorId: input.actorId,
      });
      return selectRoomForActor(tx, input.orgId, input.actorId, input.roomId);
    });
  }

  async sendMessage(input: SendChatMessageInput): Promise<ChatMessageRecord> {
    const content = normalizeChatContent(input);
    input = { ...input, ...content };
    return this.sql.begin(async (tx) => {
      const room = await selectRoomForActor(tx, input.orgId, input.actorId, input.roomId);
      if (room === null) {
        throw new ChatRoomAccessError(input.roomId);
      }
      const senderRole = room.members.find(({ actorId }) => actorId === input.actorId)?.role;
      if (
        senderRole === undefined ||
        !canPostToChatSpace(room.settings?.spaceType ?? "conversation", senderRole)
      ) {
        throw new ChatRoomAccessError(input.roomId);
      }

      if (input.parentMessageId !== undefined) {
        const parents = await tx`
          select message.id
          from messages message
          where message.id = ${input.parentMessageId}
            and message.org_id = ${input.orgId}
            and message.thread_id = ${input.roomId}
            and message.kind = 'chat'
            and message.deleted_at is null
            and helix_chat_message_visible_to(
              ${input.orgId}, ${input.actorId}, message.thread_id, message.sent_at
            )
        `;
        if (parents.length === 0) {
          throw new ChatMessageNotFoundError(input.parentMessageId);
        }
      }

      await requireActiveChatAttachments(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        objectIds: input.attachmentObjectIds ?? [],
      });
      const mentionIds = parseMentions(input.body, memberHandleResolver(room.members));
      const baseMetadata = {
        ...(input.metadata ?? {}),
        ...(mentionIds.length === 0
          ? {}
          : {
              mentions: mentionIds.map((id) =>
                id.startsWith("@")
                  ? { id, sentinel: id }
                  : {
                      id,
                      ...(room.members.find((m) => m.actorId === id)?.displayName
                        ? {
                            displayName: room.members.find((m) => m.actorId === id)?.displayName,
                          }
                        : {}),
                    },
              ),
            }),
      } as JsonObject;

      chatMetadataSchema.parse(baseMetadata);
      const messageRows = await tx<{ readonly id: string }[]>`
        insert into messages (
          org_id, thread_id, actor_id, kind, body, body_format, client_message_id, metadata,
          sent_at, parent_message_id
        )
        select
          ${input.orgId},
          ${input.roomId},
          ${input.actorId},
          'chat',
          ${input.body},
          ${input.bodyFormat ?? "plain"},
          ${input.clientMessageId ?? null},
          ${tx.json(toSqlJson(baseMetadata))},
          now(),
          ${input.parentMessageId ?? null}
        where exists (
          select 1
          from permissions grant_row
          where chat_permission_is_valid(
            grant_row,
            ${input.orgId},
            ${input.actorId},
            ${input.roomId}
          )
        )
        on conflict (org_id, actor_id, thread_id, client_message_id)
          where kind = 'chat' and client_message_id is not null
          do nothing
        returning id
      `;
      const messageId = messageRows[0]?.id;
      if (messageId === undefined) {
        const existingRows = await tx<{ readonly id: string }[]>`
          select id
          from messages
          where org_id = ${input.orgId}
            and actor_id = ${input.actorId}
            and thread_id = ${input.roomId}
            and kind = 'chat'
            and client_message_id = ${input.clientMessageId ?? null}
            and exists (
              select 1
              from permissions grant_row
              where chat_permission_is_valid(
                grant_row,
                ${input.orgId},
                ${input.actorId},
                messages.thread_id
              )
            )
          limit 1
        `;
        const existingId = existingRows[0]?.id;
        if (existingId === undefined) {
          await requireRoomAccess(tx, input.orgId, input.actorId, input.roomId);
          throw new Error("Unable to insert or locate idempotent chat message.");
        }
        const existing = await selectMessage(tx, input.orgId, existingId);
        if (existing === null) {
          throw new Error("Unable to load idempotent chat message.");
        }
        const realtimeCursor = await selectMessageCreatedCursor(
          tx,
          input.orgId,
          input.roomId,
          existingId,
        );
        if (realtimeCursor === undefined) {
          throw new Error("Idempotent chat message is missing its durable event.");
        }
        return { ...existing, realtimeCursor };
      }

      for (const objectId of input.attachmentObjectIds ?? []) {
        await tx`
          insert into message_attachments (org_id, message_id, object_id, disposition)
          values (${input.orgId}, ${messageId}, ${objectId}, 'attachment')
          on conflict do nothing
        `;
      }

      await tx`
        update threads
        set updated_at = now()
        where id = ${input.roomId}
      `;

      const aclVersion = await selectRoomAclVersion(tx, input.orgId, input.roomId);

      await tx`
        insert into outbox (subject, payload)
        values (${"activity.chat.message.created"}, ${tx.json(
          toSqlJson({
            version: 1,
            orgId: input.orgId,
            actorId: input.actorId,
            roomId: input.roomId,
            threadId: input.roomId,
            messageId,
            id: messageId,
            revision: 1,
            aclVersion,
            attachmentObjectIds: input.attachmentObjectIds ?? [],
            ...(input.parentMessageId === undefined
              ? {}
              : { parentMessageId: input.parentMessageId }),
            ...(input.clientMessageId === undefined
              ? {}
              : { clientMessageId: input.clientMessageId }),
          }),
        )})
      `;

      for (const mentioned of mentionIds) {
        if (mentioned.startsWith("@")) {
          continue;
        }
        await tx`
          insert into outbox (subject, payload)
          values (${"activity.chat.mention"}, ${tx.json(
            toSqlJson({
              orgId: input.orgId,
              actorId: input.actorId,
              roomId: input.roomId,
              messageId,
              mentionedActorId: mentioned,
            }),
          )})
        `;
      }

      if (input.suppressNotifications !== true) {
        const notificationPolicy = room.settings?.notificationPolicy ?? "all";
        for (const member of room.members) {
          if (
            !shouldNotifyChatMember(notificationPolicy, member.actorId, input.actorId, mentionIds)
          ) {
            continue;
          }
          await insertNotification(tx, {
            orgId: input.orgId,
            actorId: member.actorId,
            verb: mentionIds.includes(member.actorId) ? "chat.mentioned" : "chat.message.created",
            objectType: "chat.message",
            objectId: messageId,
            summary: room.subject ?? room.settings?.name ?? "New Chat message",
            body: input.body.slice(0, 500),
            payload: { roomId: input.roomId, messageId },
          });
        }
      }

      const message = await selectMessage(tx, input.orgId, messageId);
      if (message === null) {
        throw new Error("Unable to load inserted chat message.");
      }
      await appendChatAudit(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "chat.message.sent",
        objectType: "chat.message",
        objectId: messageId,
        metadata: { roomId: input.roomId, messageId },
      });
      const realtimeCursor = await appendChatRoomEvent(tx, chatMessageCreatedEvent(message));
      if (input.parentMessageId !== undefined) {
        const parent = await selectMessage(tx, input.orgId, input.parentMessageId);
        if (parent !== null) {
          await recordChatProjectionMutation(tx, "replied", input.actorId, parent);
        }
      }
      return { ...message, realtimeCursor };
    });
  }

  async listThreadReplies(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly parentMessageId: string;
    readonly before?: ChatMessageCursor | undefined;
    readonly direction?: "older" | "newer" | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly ChatMessageRecord[]> {
    await this.requireRoomAccess(input.orgId, input.actorId, input.roomId);
    const rows = await this.sql<ChatMessageRow[]>`
      select
        m.*,
        (select array_agg(ma.object_id::text order by ma.object_id::text) from message_attachments ma where ma.message_id = m.id) as attachment_object_ids
      from messages m
      where m.org_id = ${input.orgId}
        and m.thread_id = ${input.roomId}
        and m.kind = 'chat'
        and m.deleted_at is null
        and m.parent_message_id = ${input.parentMessageId}
        and (
          ${input.before?.sentAt ?? null}::timestamptz is null
          or (
            ${input.direction === "newer"}
            and (m.sent_at, m.id) > (${input.before?.sentAt ?? null}, ${input.before?.id ?? null}::uuid)
          )
          or (
            ${input.direction !== "newer"}
            and (m.sent_at, m.id) < (${input.before?.sentAt ?? null}, ${input.before?.id ?? null}::uuid)
          )
        )
        and helix_chat_message_visible_to(
          ${input.orgId}, ${input.actorId}, m.thread_id, m.sent_at
        )
      order by
        case when ${input.direction === "newer"} then m.sent_at end asc,
        case when ${input.direction === "newer"} then m.id end asc,
        case when ${input.direction !== "newer"} then m.sent_at end desc,
        case when ${input.direction !== "newer"} then m.id end desc
      limit ${input.limit ?? 50}
    `;
    return enrichChatMessages(this.sql, rows.map(mapMessage));
  }

  async pinMessage(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly messageId: string;
  }): Promise<ChatPinRecord> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<ChatPinRow[]>`
        insert into chat_pins (message_id, thread_id, org_id, pinned_by_actor_id)
        select ${input.messageId}, ${input.roomId}, ${input.orgId}, ${input.actorId}
        from messages message
        where message.id = ${input.messageId}
          and message.org_id = ${input.orgId}
          and message.thread_id = ${input.roomId}
          and message.kind = 'chat'
          and message.deleted_at is null
          and helix_chat_message_visible_to(
            ${input.orgId}, ${input.actorId}, message.thread_id, message.sent_at
          )
        on conflict (thread_id, message_id) do update
        set pinned_by_actor_id = excluded.pinned_by_actor_id
        returning *
      `;
      if (rows[0] === undefined) {
        await requireRoomAccess(tx, input.orgId, input.actorId, input.roomId);
        throw new ChatMessageNotFoundError(input.messageId);
      }
      const message = await selectMessage(tx, input.orgId, input.messageId);
      if (message === null) throw new ChatMessageNotFoundError(input.messageId);
      await recordChatProjectionMutation(tx, "pinned", input.actorId, message);
      return mapPin(rows[0]);
    });
  }

  async unpinMessage(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly messageId: string;
  }): Promise<{ readonly ok: true }> {
    return this.sql.begin(async (tx) => {
      const deleted = await tx`
        delete from chat_pins pin
        where pin.thread_id = ${input.roomId}
          and pin.message_id = ${input.messageId}
          and pin.org_id = ${input.orgId}
          and exists (
            select 1 from permissions grant_row
            where chat_permission_is_valid(
              grant_row, ${input.orgId}, ${input.actorId}, pin.thread_id
            )
          )
        returning pin.message_id
      `;
      if (deleted.length === 0) {
        await requireRoomAccess(tx, input.orgId, input.actorId, input.roomId);
        return { ok: true };
      }
      const message = await selectMessage(tx, input.orgId, input.messageId);
      if (message !== null) {
        await recordChatProjectionMutation(tx, "unpinned", input.actorId, message);
      }
      return { ok: true };
    });
  }

  async listPins(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<readonly ChatPinRecord[]> {
    await this.requireRoomAccess(input.orgId, input.actorId, input.roomId);
    const rows = await this.sql<ChatPinRow[]>`
      select pin.*
      from chat_pins pin
      join messages message on message.id = pin.message_id
      where pin.org_id = ${input.orgId}
        and pin.thread_id = ${input.roomId}
        and message.deleted_at is null
        and helix_chat_message_visible_to(
          ${input.orgId}, ${input.actorId}, pin.thread_id, message.sent_at
        )
      order by pin.created_at desc
    `;
    return rows.map(mapPin);
  }

  async react(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly messageId: string;
    readonly emoji: string;
    readonly op: ChatReactionOperation;
  }): Promise<ChatReactionMutationRecord> {
    return this.sql.begin(async (tx) => {
      const candidates = await tx<{ readonly thread_id: string }[]>`
        select message.thread_id
        from messages message
        where message.id = ${input.messageId}
          and message.org_id = ${input.orgId}
          and message.kind = 'chat'
          and message.deleted_at is null
          and helix_chat_message_visible_to(
            ${input.orgId}, ${input.actorId}, message.thread_id, message.sent_at
          )
        for update
      `;
      if (candidates[0] === undefined) throw new ChatMessageNotFoundError(input.messageId);

      let reaction: ChatReactionRecord | null = null;
      if (input.op === "remove") {
        await tx`
          delete from chat_reactions
          where message_id = ${input.messageId}
            and actor_id = ${input.actorId}
            and emoji = ${input.emoji}
        `;
      } else {
        const rows = await tx<ChatReactionRow[]>`
          insert into chat_reactions (message_id, actor_id, org_id, emoji)
          values (${input.messageId}, ${input.actorId}, ${input.orgId}, ${input.emoji})
          on conflict (message_id, actor_id, emoji) do update
          set created_at = chat_reactions.created_at
          returning *
        `;
        reaction = mapReaction(rows[0]);
      }
      const message = await selectMessage(tx, input.orgId, input.messageId);
      if (message === null) throw new ChatMessageNotFoundError(input.messageId);
      const realtimeCursor = await recordChatProjectionMutation(
        tx,
        input.op === "remove" ? "reaction.removed" : "reaction.added",
        input.actorId,
        message,
      );
      return { reaction, message: { ...message, realtimeCursor } };
    });
  }

  async editMessage(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly messageId: string;
    readonly body: string;
  }): Promise<ChatMessageRecord | null> {
    return this.sql.begin(async (tx) => {
      const existing = await selectMessage(tx, input.orgId, input.messageId);
      if (existing === null || existing.actorId !== input.actorId || existing.deletedAt !== null)
        return null;
      await requireRoomAccess(tx, input.orgId, input.actorId, existing.roomId);
      await requireChatMutationAllowed(tx, existing, "edit");
      const content = normalizeChatContent({
        body: input.body,
        bodyFormat: existing.bodyFormat,
        metadata: existing.metadata,
      });
      const rows = await tx<ChatMessageRow[]>`
        update messages
        set body = ${content.body}, edited_at = now(), updated_at = now()
        where id = ${input.messageId}
          and org_id = ${input.orgId}
          and actor_id = ${input.actorId}
          and kind = 'chat'
          and deleted_at is null
          and helix_chat_message_visible_to(
            ${input.orgId}, ${input.actorId}, messages.thread_id, messages.sent_at
          )
        returning
          messages.*,
          (select array_agg(ma.object_id::text order by ma.object_id::text) from message_attachments ma where ma.message_id = messages.id) as attachment_object_ids
      `;
      const message =
        rows[0] === undefined
          ? null
          : ((await enrichChatMessages(tx, [mapMessage(rows[0])]))[0] ?? null);
      if (message === null) return null;
      await appendChatAudit(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "chat.message.edited",
        objectType: "chat.message",
        objectId: input.messageId,
        metadata: { roomId: existing.roomId, messageId: input.messageId },
      });
      const realtimeCursor = await recordChatMessageMutation(tx, message, "updated", input.actorId);
      return { ...message, realtimeCursor };
    });
  }

  async deleteMessage(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly messageId: string;
  }): Promise<ChatMessageRecord | null> {
    return this.sql.begin(async (tx) => {
      const existing = await selectMessage(tx, input.orgId, input.messageId);
      if (existing === null || existing.actorId !== input.actorId || existing.deletedAt !== null)
        return null;
      await requireRoomAccess(tx, input.orgId, input.actorId, existing.roomId);
      await requireChatMutationAllowed(tx, existing, "delete");
      const rows = await tx<ChatMessageRow[]>`
        update messages
        set deleted_at = now(), updated_at = now()
        where id = ${input.messageId}
          and org_id = ${input.orgId}
          and actor_id = ${input.actorId}
          and kind = 'chat'
          and deleted_at is null
          and helix_chat_message_visible_to(
            ${input.orgId}, ${input.actorId}, messages.thread_id, messages.sent_at
          )
          and not exists (
            select 1
            from chat_room_settings held_room
            where held_room.org_id = messages.org_id
              and held_room.thread_id = messages.thread_id
              and coalesce((held_room.metadata->>'legalHold')::boolean, false)
          )
        returning
          messages.*,
          (select array_agg(ma.object_id::text order by ma.object_id::text) from message_attachments ma where ma.message_id = messages.id) as attachment_object_ids
      `;
      if (rows[0] !== undefined) {
        await tx`delete from message_attachments where message_id = ${input.messageId} and org_id = ${input.orgId}`;
      }
      const message =
        rows[0] === undefined
          ? null
          : ((await enrichChatMessages(tx, [mapMessage(rows[0])]))[0] ?? null);
      if (message === null) return null;
      await appendChatAudit(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "chat.message.deleted",
        objectType: "chat.message",
        objectId: input.messageId,
        metadata: { roomId: existing.roomId, messageId: input.messageId },
      });
      const realtimeCursor = await recordChatMessageMutation(tx, message, "deleted", input.actorId);
      return { ...message, realtimeCursor };
    });
  }

  async markRead(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly messageId: string;
  }): Promise<ChatReadReceiptRecord> {
    const rows = await this.sql<ChatReadReceiptRow[]>`
      with candidate as materialized (
        select
          message.id,
          message.chat_room_sequence,
          coalesce(settings.read_receipts_enabled, true) as is_shared
        from messages message
        join threads thread
          on thread.id = message.thread_id
         and thread.org_id = message.org_id
         and thread.kind in ('chat_room', 'chat_dm')
        left join chat_room_settings settings
          on settings.thread_id = thread.id
         and settings.org_id = thread.org_id
        join permissions membership
          on chat_permission_is_valid(
            membership,
            ${input.orgId},
            ${input.actorId},
            thread.id
          )
        where message.id = ${input.messageId}
          and message.org_id = ${input.orgId}
          and message.thread_id = ${input.roomId}
          and message.kind = 'chat'
          and message.deleted_at is null
          and message.chat_room_sequence is not null
          and helix_chat_message_visible_to(
            ${input.orgId}, ${input.actorId}, message.thread_id, message.sent_at
          )
        limit 1
      ), upserted as (
        insert into chat_read_receipts (
          thread_id,
          actor_id,
          org_id,
          last_read_message_id,
          last_read_sequence,
          last_read_at,
          updated_at
        )
        select
          ${input.roomId},
          ${input.actorId},
          ${input.orgId},
          candidate.id,
          candidate.chat_room_sequence,
          now(),
          now()
        from candidate
        on conflict (thread_id, actor_id) do update
        set
          last_read_message_id = excluded.last_read_message_id,
          last_read_sequence = excluded.last_read_sequence,
          last_read_at = excluded.last_read_at,
          updated_at = now()
        where chat_read_receipts.org_id = excluded.org_id
          and (
            chat_read_receipts.last_read_sequence is null
            or excluded.last_read_sequence > chat_read_receipts.last_read_sequence
          )
        returning chat_read_receipts.*
      ), resolved as materialized (
        select upserted.*, candidate.is_shared, true as advanced
        from upserted
        cross join candidate
        union all
        select receipt.*, candidate.is_shared, false as advanced
        from candidate
        join chat_read_receipts receipt
          on receipt.thread_id = ${input.roomId}
         and receipt.actor_id = ${input.actorId}
         and receipt.org_id = ${input.orgId}
        where not exists (select 1 from upserted)
        limit 1
      )
      select
        resolved.*,
        case when resolved.advanced and resolved.is_shared then (
          select event_sequence
          from append_chat_room_event(
            resolved.org_id,
            resolved.thread_id,
            jsonb_build_object(
              'type', 'read',
              'actorId', resolved.actor_id,
              'messageId', resolved.last_read_message_id,
              'receipt', jsonb_build_object(
                'roomId', resolved.thread_id,
                'actorId', resolved.actor_id,
                'orgId', resolved.org_id,
                'lastReadMessageId', resolved.last_read_message_id,
                'lastReadAt', resolved.last_read_at,
                'updatedAt', resolved.updated_at
              )
            )
          )
        )
        end as realtime_cursor
      from resolved
    `;
    if (rows[0] === undefined) {
      throw new ChatMessageNotFoundError(input.messageId);
    }
    return mapReadReceipt(rows[0]);
  }

  async listReadReceipts(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<readonly ChatReadReceiptRecord[]> {
    await this.requireRoomAccess(input.orgId, input.actorId, input.roomId);
    const rows = await this.sql<ChatReadReceiptRow[]>`
      select
        receipt.*,
        coalesce(settings.read_receipts_enabled, true) as is_shared
      from chat_read_receipts receipt
      left join chat_room_settings settings
        on settings.thread_id = receipt.thread_id
       and settings.org_id = receipt.org_id
      where receipt.org_id = ${input.orgId}
        and receipt.thread_id = ${input.roomId}
        and exists (
          select 1
          from permissions requester
          where chat_permission_is_valid(
            requester,
            ${input.orgId},
            ${input.actorId},
            receipt.thread_id
          )
        )
        and (
          coalesce(settings.read_receipts_enabled, true)
          or receipt.actor_id = ${input.actorId}
        )
        and exists (
          select 1
          from permissions membership
          where chat_permission_is_valid(
            membership,
            receipt.org_id,
            receipt.actor_id,
            receipt.thread_id
          )
        )
      order by receipt.updated_at desc
    `;
    return rows.map((row) => mapReadReceipt(row));
  }

  async listMessages(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly before?: ChatMessageCursor | undefined;
    readonly direction?: "older" | "newer" | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly ChatMessageRecord[]> {
    await this.requireRoomAccess(input.orgId, input.actorId, input.roomId);
    const rows = await this.sql<ChatMessageRow[]>`
      select
        m.*,
        (select array_agg(ma.object_id::text order by ma.object_id::text) from message_attachments ma where ma.message_id = m.id) as attachment_object_ids
      from messages m
      where m.org_id = ${input.orgId}
        and m.thread_id = ${input.roomId}
        and m.kind = 'chat'
        and m.deleted_at is null
        and (
          ${input.before?.sentAt ?? null}::timestamptz is null
          or (
            ${input.direction === "newer"}
            and (m.sent_at, m.id) > (${input.before?.sentAt ?? null}, ${input.before?.id ?? null}::uuid)
          )
          or (
            ${input.direction !== "newer"}
            and (m.sent_at, m.id) < (${input.before?.sentAt ?? null}, ${input.before?.id ?? null}::uuid)
          )
        )
        and helix_chat_message_visible_to(
          ${input.orgId}, ${input.actorId}, m.thread_id, m.sent_at
        )
      order by
        case when ${input.direction === "newer"} then m.sent_at end asc,
        case when ${input.direction === "newer"} then m.id end asc,
        case when ${input.direction !== "newer"} then m.sent_at end desc,
        case when ${input.direction !== "newer"} then m.id end desc
      limit ${input.limit ?? 50}
    `;
    return enrichChatMessages(this.sql, rows.map(mapMessage));
  }

  async exportRoom(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<ChatRoomExportRecord> {
    const room = await this.getRoomForActor(input);
    if (room === null) throw new ChatRoomAccessError(input.roomId);
    const rows = await this.sql<ChatMessageRow[]>`
      select
        message.*,
        (
          select array_agg(attachment.object_id::text order by attachment.object_id::text)
          from message_attachments attachment
          where attachment.message_id = message.id
        ) as attachment_object_ids
      from messages message
      where message.org_id = ${input.orgId}
        and message.thread_id = ${input.roomId}
        and message.kind = 'chat'
        and message.deleted_at is null
        and helix_chat_message_visible_to(
          ${input.orgId}, ${input.actorId}, message.thread_id, message.sent_at
        )
      order by message.sent_at, message.id
    `;
    return {
      version: 1,
      exportedAt: new Date(),
      room,
      messages: await enrichChatMessages(this.sql, rows.map(mapMessage)),
    };
  }

  async importMessages(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly messages: readonly {
      readonly sourceMessageId: string;
      readonly body: string;
      readonly bodyFormat: "plain" | "markdown";
      readonly sentAt?: string | undefined;
      readonly metadata: JsonObject;
    }[];
  }): Promise<{ readonly roomId: string; readonly messageIds: readonly string[] }> {
    const room = await this.getRoomForActor(input);
    const role = room?.members.find((member) => member.actorId === input.actorId)?.role;
    if (role !== "owner" && role !== "moderator") {
      throw new ChatRoomAccessError(input.roomId);
    }
    const messageIds: string[] = [];
    for (const message of input.messages) {
      const record = await this.sendMessage({
        orgId: input.orgId,
        actorId: input.actorId,
        roomId: input.roomId,
        body: message.body,
        bodyFormat: message.bodyFormat,
        clientMessageId: `import:${message.sourceMessageId}`,
        suppressNotifications: true,
        metadata: {
          ...message.metadata,
          imported: true,
          ...(message.sentAt === undefined ? {} : { importedSentAt: message.sentAt }),
        },
      });
      messageIds.push(record.id);
    }
    return { roomId: input.roomId, messageIds };
  }

  async search(input: ChatSearchRequest): Promise<readonly ChatSearchHit[]> {
    const rows = await this.sql<ChatSearchRow[]>`
      select
        m.thread_id,
        m.id as message_id,
        m.actor_id,
        t.subject,
        m.body,
        m.sent_at
      from messages m
      join threads t on t.id = m.thread_id
      where m.org_id = ${input.orgId}
        and m.kind = 'chat'
        and m.deleted_at is null
        and (${input.roomId ?? null}::uuid is null or m.thread_id = ${input.roomId ?? null})
        and (${input.query ?? ""} = '' or t.subject ilike ${`%${input.query ?? ""}%`} or m.body ilike ${`%${input.query ?? ""}%`})
        and helix_chat_message_visible_to(
          ${input.orgId}, ${input.actorId}, m.thread_id, m.sent_at
        )
      order by m.sent_at desc
      limit ${input.limit ?? 50}
    `;
    return rows.map(mapSearchHit);
  }

  async getChatSearchRecord(messageId: string): Promise<ChatSearchRecord | null> {
    const rows = await this.sql<ChatSearchRecordRow[]>`
      select
        m.id,
        m.org_id,
        m.thread_id,
        m.actor_id,
        m.body,
        m.metadata,
        m.sent_at,
        m.edited_at,
        m.deleted_at,
        m.updated_at,
        t.subject as room_subject,
        t.kind as room_kind,
        s.name as room_name,
        coalesce(s.acl_version, 0) as room_acl_version,
        array(
          select distinct permission.actor_id::text
          from permissions permission
          where chat_permission_is_valid(
            permission,
            m.org_id,
            permission.actor_id,
            m.thread_id
          )
            and helix_chat_message_visible_to(
              m.org_id, permission.actor_id, m.thread_id, m.sent_at
            )
          order by permission.actor_id::text
        ) as allowed_actor_ids,
        a.display_name as actor_display_name,
        a.email as actor_email
      from messages m
      join threads t on t.id = m.thread_id
      left join chat_room_settings s on s.thread_id = t.id
      left join actors a on a.id = m.actor_id
      where m.id = ${messageId}
        and m.kind = 'chat'
      limit 1
    `;
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const reactionRows = await this.sql<ChatReactionRow[]>`
      select message_id, actor_id, org_id, emoji, created_at
      from chat_reactions
      where message_id = ${messageId}
      order by created_at, emoji, actor_id
    `;
    return mapChatSearchRecord(row, reactionRows);
  }

  getChatEnrichmentRecord(messageId: string): Promise<ChatEnrichmentRecord | null> {
    return this.getChatSearchRecord(messageId);
  }

  async recordChatEnrichment(input: ChatEnrichmentWrite): Promise<void> {
    await this.sql`
      update messages
      set
        metadata = jsonb_set(
          metadata,
          '{enrichments}',
          coalesce(metadata->'enrichments', '{}'::jsonb) ||
            jsonb_build_object(${input.feature}, ${this.sql.json(toSqlJson(input.data))}::jsonb),
          true
        ),
        updated_at = now()
      where id = ${input.messageId}
        and thread_id = ${input.roomId}
        and kind = 'chat'
    `;
  }

  async getRoomForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<ChatRoomRecord | null> {
    return selectRoomForActor(this.sql, input.orgId, input.actorId, input.roomId);
  }

  async listPresenceBlockedActorIds(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly candidateActorIds: readonly string[];
  }): Promise<readonly string[]> {
    if (input.candidateActorIds.length === 0) return [];
    const rows = await this.sql<{ readonly actor_id: string }[]>`
      select actor_id from helix_chat_presence_blocked_actor_ids(
        ${input.orgId}, ${input.actorId}, ${this.sql.array([...input.candidateActorIds])}::uuid[]
      )
    `;
    return rows.map((row) => row.actor_id);
  }

  private async requireRoomAccess(orgId: string, actorId: string, roomId: string): Promise<void> {
    await requireRoomAccess(this.sql, orgId, actorId, roomId);
  }

  private async touchRoom(roomId: string): Promise<void> {
    await this.sql`update threads set updated_at = now() where id = ${roomId}`;
  }
}

async function selectRoomForActor(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  roomId: string,
): Promise<ChatRoomRecord | null> {
  const rows = await sql<ChatRoomRow[]>`
    select
      t.*,
      s.thread_id as settings_thread_id,
      s.org_id as settings_org_id,
      s.name as settings_name,
      s.topic as settings_topic,
      s.privacy as settings_privacy,
      s.read_receipts_enabled as settings_read_receipts_enabled,
      s.metadata as settings_metadata,
      s.created_at as settings_created_at,
      s.updated_at as settings_updated_at,
      (
        select coalesce(
          jsonb_agg(
            jsonb_build_object(
              'actorId', p.actor_id::text,
              'role', p.role,
              'displayName', a.display_name,
              'email', a.email
            )
            order by a.display_name nulls last, p.actor_id::text
          ),
          '[]'::jsonb
        )
        from permissions p
        join actors a on a.id = p.actor_id and a.org_id = p.org_id
        where chat_permission_is_valid(p, ${orgId}, p.actor_id, t.id)
      ) as members
    from threads t
    left join chat_room_settings s on s.thread_id = t.id
    where t.id = ${roomId}
      and t.org_id = ${orgId}
      and t.kind in ('chat_room', 'chat_dm')
      and exists (
        select 1 from permissions access_grant
        where chat_permission_is_valid(access_grant, ${orgId}, ${actorId}, t.id)
      )
    limit 1
  `;
  return rows[0] === undefined ? null : mapRoom(rows[0]);
}

async function selectRoomByParticipantKey(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  participantKey: string,
): Promise<ChatRoomRecord | null> {
  const rows = await sql<{ readonly thread_id: string }[]>`
    select thread_id
    from chat_room_settings
    where org_id = ${orgId}
      and participant_key = ${participantKey}
    limit 1
  `;
  const roomId = rows[0]?.thread_id;
  return roomId === undefined ? null : selectRoomForActor(sql, orgId, actorId, roomId);
}

async function requireRoomAccess(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  roomId: string,
): Promise<void> {
  const room = await selectRoomForActor(sql, orgId, actorId, roomId);
  if (room === null) {
    throw new ChatRoomAccessError(roomId);
  }
}

async function selectMessage(
  sql: SqlLike,
  orgId: string,
  messageId: string,
): Promise<ChatMessageRecord | null> {
  const rows = await sql<ChatMessageRow[]>`
    select
      m.*,
      (select array_agg(ma.object_id::text order by ma.object_id::text) from message_attachments ma where ma.message_id = m.id) as attachment_object_ids
    from messages m
    where m.id = ${messageId}
      and m.org_id = ${orgId}
      and m.kind = 'chat'
    limit 1
  `;
  if (rows[0] === undefined) return null;
  return (await enrichChatMessages(sql, [mapMessage(rows[0])]))[0] ?? null;
}

async function enrichChatMessages(
  sql: SqlLike,
  messages: readonly ChatMessageRecord[],
): Promise<readonly ChatMessageRecord[]> {
  if (messages.length === 0) return [];
  const rows = await sql<ChatMessageStateRow[]>`
    select
      source.id as message_id,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'messageId', reaction.message_id,
            'actorId', reaction.actor_id,
            'orgId', reaction.org_id,
            'emoji', reaction.emoji,
            'createdAt', reaction.created_at
          )
          order by reaction.emoji, reaction.created_at, reaction.actor_id
        )
        from chat_reactions reaction
        where reaction.message_id = source.id
      ), '[]'::jsonb) as reactions,
      (
        select count(*)::int
        from messages reply
        where reply.parent_message_id = source.id
          and reply.kind = 'chat'
          and reply.deleted_at is null
      ) as reply_count,
      (
        select jsonb_build_object(
          'roomId', pin.thread_id,
          'messageId', pin.message_id,
          'orgId', pin.org_id,
          'pinnedByActorId', pin.pinned_by_actor_id,
          'createdAt', pin.created_at
        )
        from chat_pins pin
        where pin.message_id = source.id
      ) as pin,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'objectId', object.id,
            'source', case when object.kind::text = 'chat_attachment' then 'chat' else 'drive' end,
            'filename', linked.snapshot->>'filename',
            'mimeType', linked.snapshot->>'mimeType',
            'byteSize', (linked.snapshot->>'byteSize')::bigint
          ) order by linked.object_id
        )
        from message_attachments linked
        join objects object
          on object.org_id = linked.org_id and object.id = linked.object_id
        left join chat_attachments attachment
          on attachment.org_id = linked.org_id and attachment.object_id = linked.object_id
        where linked.message_id = source.id
          and object.deleted_at is null
          and (
            object.kind::text in ('file', 'recording')
            or (object.kind::text = 'chat_attachment' and attachment.status = 'ready')
          )
      ), '[]'::jsonb) as attachments
    from unnest(${sql.array(messages.map(({ id }) => id))}::uuid[]) as source(id)
  `;
  const states = new Map(rows.map((row) => [row.message_id, row]));
  return messages.map((message) => {
    const state = states.get(message.id);
    return {
      ...message,
      reactions: (state?.reactions ?? []).map((reaction) => ({
        messageId: reaction.messageId,
        actorId: reaction.actorId,
        orgId: reaction.orgId,
        emoji: reaction.emoji,
        createdAt: new Date(reaction.createdAt),
      })),
      replyCount: Number(state?.reply_count ?? 0),
      attachments: (state?.attachments ?? []).map((attachment) => ({
        objectId: attachment.objectId,
        source: attachment.source,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        byteSize: Number(attachment.byteSize),
      })),
      pin:
        state?.pin === undefined || state.pin === null
          ? null
          : {
              roomId: state.pin.roomId,
              messageId: state.pin.messageId,
              orgId: state.pin.orgId,
              pinnedByActorId: state.pin.pinnedByActorId,
              createdAt: new Date(state.pin.createdAt),
            },
    };
  });
}

async function appendChatRoomEvent(sql: SqlLike, event: ChatRoomEvent): Promise<number> {
  const rows = await sql<{ readonly event_sequence: number | string }[]>`
    select event_sequence
    from append_chat_room_event(
      ${event.orgId},
      ${event.roomId},
      ${sql.json(toSqlJson(event))}
    )
  `;
  return safeChatEventCursor(rows[0]?.event_sequence);
}

async function recordChatMessageMutation(
  sql: SqlLike,
  message: ChatMessageRecord,
  operation: "updated" | "deleted",
  actorId: string,
): Promise<number> {
  await sql`update threads set updated_at = now() where id = ${message.roomId}`;
  const aclVersion = await selectRoomAclVersion(sql, message.orgId, message.roomId);
  await sql`
    insert into outbox (subject, payload)
    values (
      ${`activity.chat.message.${operation}`},
      ${sql.json(
        toSqlJson({
          version: 1,
          orgId: message.orgId,
          actorId,
          roomId: message.roomId,
          messageId: message.id,
          revision: message.revision ?? 1,
          aclVersion,
        }),
      )}
    )
  `;
  return appendChatRoomEvent(
    sql,
    operation === "updated"
      ? chatMessageUpdatedEvent(message)
      : chatMessageDeletedEvent(message, actorId),
  );
}

async function recordChatProjectionMutation(
  sql: SqlLike,
  operation: "pinned" | "unpinned" | "reaction.added" | "reaction.removed" | "replied",
  actorId: string,
  message: ChatMessageRecord,
): Promise<number> {
  await sql`update threads set updated_at = now() where id = ${message.roomId}`;
  await sql`
    insert into outbox (subject, payload)
    values (
      ${`activity.chat.message.${operation}`},
      ${sql.json(
        toSqlJson({
          version: 1,
          orgId: message.orgId,
          roomId: message.roomId,
          actorId,
          messageId: message.id,
        }),
      )}
    )
  `;
  return appendChatRoomEvent(sql, chatMessageUpdatedEvent(message));
}

async function selectRoomAclVersion(sql: SqlLike, orgId: string, roomId: string): Promise<number> {
  const settings = await sql<{ readonly acl_version: number | string }[]>`
    select acl_version
    from chat_room_settings
    where org_id = ${orgId} and thread_id = ${roomId}
  `;
  return Number(settings[0]?.acl_version ?? 0);
}

async function selectMessageCreatedCursor(
  sql: SqlLike,
  orgId: string,
  roomId: string,
  messageId: string,
): Promise<number | undefined> {
  const rows = await sql<{ readonly sequence: number | string }[]>`
    select sequence
    from chat_room_events
    where org_id = ${orgId}
      and room_id = ${roomId}
      and event->>'type' = 'message.created'
      and event->'message'->>'id' = ${messageId}
    limit 1
  `;
  return rows[0] === undefined ? undefined : safeChatEventCursor(rows[0].sequence);
}

async function grantRoomAccess(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly actorId: string;
    readonly role: ChatRoomRole;
    readonly grantedByActorId: string;
  },
): Promise<void> {
  await sql`
    delete from permissions
    where org_id = ${input.orgId}
      and actor_id = ${input.actorId}
      and resource_type = 'thread'
      and resource_id = ${input.roomId}
      and (
        ${input.role} = 'owner'
        or role <> 'owner'
        or not chat_permission_is_valid(
          permissions,
          ${input.orgId},
          ${input.actorId},
          ${input.roomId}
        )
      )
  `;
  const rows = await sql`
    insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
    select ${input.orgId}, actor.id, 'thread', ${input.roomId}, ${input.role}, ${input.grantedByActorId}
    from actors actor
    where actor.id = ${input.actorId}
      and actor.org_id = ${input.orgId}
      and actor.disabled_at is null
      and (
        (
          ${input.role} = 'owner'
          and actor.id = ${input.grantedByActorId}
          and exists (
            select 1
            from threads room
            where room.id = ${input.roomId}
              and room.org_id = ${input.orgId}
              and room.created_by_actor_id = ${input.grantedByActorId}
              and room.kind in ('chat_room', 'chat_dm')
          )
        )
        or exists (
          select 1
          from permissions grantor_grant
          where chat_permission_is_valid(
            grantor_grant,
            ${input.orgId},
            ${input.grantedByActorId},
            ${input.roomId}
          )
            and (
              grantor_grant.role = 'owner'
              or (${input.role} = 'member' and grantor_grant.role = 'moderator')
            )
        )
        or (
          actor.id = ${input.grantedByActorId}
          and ${input.role} = 'member'
          and exists (
            select 1
            from chat_room_settings settings
            join threads room
              on room.id = settings.thread_id and room.org_id = settings.org_id
            where room.id = ${input.roomId}
              and room.org_id = ${input.orgId}
              and room.kind = 'chat_room'
              and settings.privacy = 'discoverable'
          )
        )
      )
      and (
        ${input.role} = 'owner'
        or not exists (
          select 1 from permissions existing
          where chat_permission_is_valid(
            existing,
            ${input.orgId},
            ${input.actorId},
            ${input.roomId}
          )
            and existing.role = 'owner'
        )
      )
    returning id
  `;
  if (rows.length === 0) {
    throw new ChatMemberAccessError();
  }
}

function directParticipantKey(actorIds: readonly string[]): string {
  return createHash("sha256")
    .update([...actorIds].sort().join(","))
    .digest("hex");
}

async function requireActiveOrgActors(
  sql: SqlLike,
  orgId: string,
  actorIds: readonly string[],
): Promise<void> {
  if (actorIds.length === 0) return;
  const rows = await sql<{ readonly id: string }[]>`
    select id
    from actors
    where org_id = ${orgId}
      and id = any(${sql.array([...actorIds])}::uuid[])
      and disabled_at is null
  `;
  if (new Set(rows.map((row) => row.id)).size !== new Set(actorIds).size) {
    throw new ChatMemberAccessError();
  }
}

async function requireAllowedExternalActors(
  sql: SqlLike,
  orgId: string,
  actorIds: readonly string[],
  externalAccess: ChatExternalAccess,
): Promise<void> {
  if (actorIds.length === 0) return;
  const rows = await sql<
    { readonly id: string; readonly guest_type: "member" | "external" | "partner" | null }[]
  >`
    select
      actor.id,
      case
        when actor.type = 'user' then membership.guest_type
        else 'member'
      end as guest_type
    from actors actor
    left join organization_memberships membership
      on membership.org_id = actor.org_id
     and membership.actor_id = actor.id
     and membership.status = 'active'
    where actor.org_id = ${orgId}
      and actor.id = any(${sql.array([...actorIds])}::uuid[])
      and actor.disabled_at is null
  `;
  if (
    new Set(rows.map((row) => row.id)).size !== new Set(actorIds).size ||
    rows.some(
      (row) => row.guest_type === null || !canInviteChatGuest(externalAccess, row.guest_type),
    )
  ) {
    throw new ChatMemberAccessError();
  }
}

function expectRoom(room: ChatRoomRecord | null, roomId: string): ChatRoomRecord {
  if (room === null) {
    throw new Error(`Unable to load chat room: ${roomId}`);
  }
  return room;
}

function mapRoom(row: ChatRoomRow): ChatRoomRecord {
  const settingsMetadata = row.settings_metadata ?? {};
  const governance = readChatGovernance(row.kind, settingsMetadata);
  return {
    id: row.id,
    orgId: row.org_id,
    kind: row.kind,
    subject: row.subject,
    createdByActorId: row.created_by_actor_id,
    metadata: row.metadata,
    members: chatRoomMembers(row.members),
    settings:
      row.settings_thread_id === null
        ? null
        : {
            threadId: row.settings_thread_id,
            orgId: row.settings_org_id ?? row.org_id,
            name: row.settings_name,
            topic: row.settings_topic,
            privacy: row.settings_privacy ?? "restricted",
            readReceiptsEnabled: row.settings_read_receipts_enabled ?? true,
            ...governance,
            metadata: settingsMetadata,
            createdAt: row.settings_created_at ?? row.created_at,
            updatedAt: row.settings_updated_at ?? row.updated_at,
          },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function chatRoomMembers(value: unknown): ChatRoomRecord["members"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null) {
      return [];
    }
    const record = candidate as Record<string, unknown>;
    return typeof record.actorId === "string" && isChatRoomRole(record.role)
      ? [
          {
            actorId: record.actorId,
            role: record.role,
            displayName: typeof record.displayName === "string" ? record.displayName : null,
            email: typeof record.email === "string" ? record.email : null,
          },
        ]
      : [];
  });
}

function isChatRoomRole(value: unknown): value is ChatRoomRole {
  return value === "owner" || value === "moderator" || value === "member";
}

function mapMessage(row: ChatMessageRow): ChatMessageRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    roomId: row.thread_id,
    actorId: row.actor_id,
    body: row.body,
    bodyFormat: chatBodyFormatSchema.catch("plain").parse(row.body_format),
    renderedBodyHtml: renderChatBodyHtml(
      row.body,
      chatBodyFormatSchema.catch("plain").parse(row.body_format),
    ),
    metadata: row.metadata,
    attachmentObjectIds: row.deleted_at === null ? (row.attachment_object_ids ?? []) : [],
    parentMessageId: row.parent_message_id ?? null,
    ...(row.client_message_id === null ? {} : { clientMessageId: row.client_message_id }),
    revision: Number(row.chat_revision ?? 1),
    sentAt: row.sent_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPin(row: ChatPinRow | undefined): ChatPinRecord {
  if (row === undefined) {
    throw new Error("Expected chat pin row.");
  }
  return {
    roomId: row.thread_id,
    messageId: row.message_id,
    orgId: row.org_id,
    pinnedByActorId: row.pinned_by_actor_id,
    createdAt: row.created_at,
  };
}

function mapReaction(row: ChatReactionRow | undefined): ChatReactionRecord {
  if (row === undefined) {
    throw new Error("Expected chat reaction row.");
  }
  return {
    messageId: row.message_id,
    actorId: row.actor_id,
    orgId: row.org_id,
    emoji: row.emoji,
    createdAt: row.created_at,
  };
}

function mapReadReceipt(row: ChatReadReceiptRow | undefined): ChatReadReceiptRecord {
  if (row === undefined) {
    throw new Error("Expected chat read receipt row.");
  }
  return {
    roomId: row.thread_id,
    actorId: row.actor_id,
    orgId: row.org_id,
    lastReadMessageId: row.last_read_message_id,
    lastReadAt: row.last_read_at,
    updatedAt: row.updated_at,
    isShared: row.is_shared,
    ...(row.realtime_cursor === undefined
      ? {}
      : {
          realtimeCursor:
            row.realtime_cursor === null ? null : safeChatEventCursor(row.realtime_cursor),
        }),
  };
}

export function chatMessageCreatedEvent(message: ChatMessageRecord): ChatRoomEvent {
  return {
    version: 1,
    type: "message.created",
    roomId: message.roomId,
    orgId: message.orgId,
    ...(message.actorId === null ? {} : { actorId: message.actorId }),
    message: {
      id: message.id,
      orgId: message.orgId,
      roomId: message.roomId,
      actorId: message.actorId,
      body: message.body,
      bodyFormat: message.bodyFormat,
      renderedBodyHtml: renderChatBodyHtml(
        message.body,
        chatBodyFormatSchema.catch("plain").parse(message.bodyFormat),
      ),
      metadata: message.metadata,
      attachmentObjectIds: [...message.attachmentObjectIds],
      attachments: (message.attachments ?? []).map((attachment) => ({
        objectId: attachment.objectId,
        source: attachment.source,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        byteSize: attachment.byteSize,
      })),
      reactions: (message.reactions ?? []).map((reaction) => ({
        messageId: reaction.messageId,
        actorId: reaction.actorId,
        orgId: reaction.orgId,
        emoji: reaction.emoji,
        createdAt: reaction.createdAt.toISOString(),
      })),
      replyCount: message.replyCount ?? 0,
      pin:
        message.pin === undefined || message.pin === null
          ? null
          : {
              roomId: message.pin.roomId,
              messageId: message.pin.messageId,
              orgId: message.pin.orgId,
              pinnedByActorId: message.pin.pinnedByActorId,
              createdAt: message.pin.createdAt.toISOString(),
            },
      parentMessageId: message.parentMessageId ?? null,
      ...(message.clientMessageId === undefined
        ? {}
        : { clientMessageId: message.clientMessageId }),
      revision: message.revision ?? 1,
      sentAt: message.sentAt.toISOString(),
      editedAt: message.editedAt?.toISOString() ?? null,
      deletedAt: message.deletedAt?.toISOString() ?? null,
      createdAt: message.createdAt.toISOString(),
      updatedAt: message.updatedAt.toISOString(),
    },
    ...(message.realtimeCursor === undefined ? {} : { cursor: message.realtimeCursor }),
  };
}

export function chatMessageUpdatedEvent(message: ChatMessageRecord): ChatRoomEvent {
  return { ...chatMessageCreatedEvent(message), type: "message.updated" };
}

export function chatMessageDeletedEvent(
  message: ChatMessageRecord,
  actorId: string,
): ChatRoomEvent {
  return {
    version: 1,
    type: "message.deleted",
    orgId: message.orgId,
    roomId: message.roomId,
    actorId,
    messageId: message.id,
    revision: message.revision ?? 1,
    deletedAt: message.deletedAt?.toISOString() ?? new Date().toISOString(),
    ...(message.realtimeCursor === undefined ? {} : { cursor: message.realtimeCursor }),
  };
}

export function chatReadEvent(receipt: ChatReadReceiptRecord): ChatRoomEvent {
  return {
    type: "read",
    roomId: receipt.roomId,
    orgId: receipt.orgId,
    actorId: receipt.actorId,
    messageId: receipt.lastReadMessageId,
    receipt: {
      roomId: receipt.roomId,
      actorId: receipt.actorId,
      orgId: receipt.orgId,
      lastReadMessageId: receipt.lastReadMessageId,
      lastReadAt: receipt.lastReadAt.toISOString(),
      updatedAt: receipt.updatedAt.toISOString(),
    },
    ...(receipt.realtimeCursor === undefined || receipt.realtimeCursor === null
      ? {}
      : { cursor: receipt.realtimeCursor }),
  };
}

function mapSearchHit(row: ChatSearchRow): ChatSearchHit {
  return {
    roomId: row.thread_id,
    messageId: row.message_id,
    actorId: row.actor_id,
    subject: row.subject ?? "",
    preview: row.body.slice(0, 240),
    sentAt: row.sent_at,
  };
}

function mapChatSearchRecord(
  row: ChatSearchRecordRow,
  reactions: readonly ChatReactionRow[],
): ChatSearchRecord {
  const classification = chatClassification(sensitivityClassificationFromMetadata(row.metadata));
  const mentions = chatParticipants(row.metadata.mentions);
  const roomName = row.room_name ?? row.room_subject ?? undefined;
  return {
    id: row.id,
    orgId: row.org_id,
    roomId: row.thread_id,
    ...(roomName === undefined ? {} : { roomName }),
    roomKind: row.room_kind,
    aclVersion: Number(row.room_acl_version),
    allowedActorIds: row.allowed_actor_ids ?? [],
    body: row.body,
    author: {
      id: row.actor_id ?? "unknown",
      ...(row.actor_display_name === null ? {} : { displayName: row.actor_display_name }),
      ...(row.actor_email === null ? {} : { email: row.actor_email }),
    },
    ...(mentions.length === 0 ? {} : { mentions }),
    reactions: reactions.map(mapSearchReaction),
    ...(classification === undefined ? {} : { classification }),
    createdAt: row.sent_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.edited_at === null ? {} : { editedAt: row.edited_at.toISOString() }),
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at.toISOString() }),
    metadata: row.metadata,
  };
}

function mapSearchReaction(row: ChatReactionRow): ChatSearchReactionRecord {
  return {
    emoji: row.emoji,
    actorId: row.actor_id,
    createdAt: row.created_at.toISOString(),
  };
}

function chatParticipants(value: unknown): readonly ChatSearchRecord["author"][] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(chatParticipant)
    .filter((participant): participant is ChatSearchRecord["author"] => participant !== undefined);
}

function chatParticipant(value: unknown): ChatSearchRecord["author"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    ? {
        id: record.id,
        ...(typeof record.displayName === "string" ? { displayName: record.displayName } : {}),
        ...(typeof record.email === "string" ? { email: record.email } : {}),
      }
    : undefined;
}

function chatClassification(value: unknown): ChatSearchRecord["classification"] {
  return value === "public" ||
    value === "standard" ||
    value === "confidential" ||
    value === "restricted"
    ? value
    : undefined;
}

function safeChatEventCursor(value: number | string | undefined): number {
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor <= 0) {
    throw new RangeError("Chat event cursor is outside the safe integer range.");
  }
  return cursor;
}

function chatTransactionSql(tx: postgres.TransactionSql): postgres.Sql {
  const sql = new Proxy(tx, {
    apply(target, _thisArg, args): unknown {
      return Reflect.apply(target, tx, args);
    },
    has(target, property): boolean {
      return property === "begin" || Reflect.has(target, property);
    },
    get(target, property, receiver): unknown {
      if (property === "begin") {
        return <T>(callback: (nested: postgres.TransactionSql) => Promise<T>) =>
          tx.savepoint(callback) as Promise<T>;
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(tx) : value;
    },
  });
  if (!isPostgresSql(sql)) {
    throw new TypeError("Chat transaction adapter is invalid.");
  }
  return sql;
}

function isPostgresSql(value: unknown): value is postgres.Sql {
  return typeof value === "function" && "begin" in value && typeof value.begin === "function";
}

interface ChatRetentionPolicyRow {
  readonly org_id: string;
  readonly thread_id: string | null;
  readonly retention_days: number;
  readonly edit_window_seconds: number;
  readonly delete_window_seconds: number;
  readonly legal_hold: boolean;
  readonly updated_at: Date;
}

interface ChatExportMessageRow {
  readonly id: string;
  readonly thread_id: string;
  readonly actor_id: string | null;
  readonly body: string | null;
  readonly body_format: string;
  readonly sent_at: Date;
  readonly edited_at: Date | null;
  readonly deleted_at: Date | null;
}

async function lockChatCompliance(sql: SqlLike, orgId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${orgId}, 77332))`;
}

async function requireChatRoomExistsInOrg(
  sql: SqlLike,
  orgId: string,
  roomId: string,
): Promise<void> {
  const rows = await sql<readonly { readonly "?column?": number }[]>`
    select 1
    from threads
    where id = ${roomId}
      and org_id = ${orgId}
      and kind in ('chat_room', 'chat_dm')
    limit 1
  `;
  if (rows.length !== 1) throw new ChatRoomAccessError();
}

async function requireChatMutationAllowed(
  sql: SqlLike,
  message: ChatMessageRecord,
  operation: "edit" | "delete",
): Promise<void> {
  await lockChatCompliance(sql, message.orgId);
  const rows = await sql<
    readonly {
      readonly legal_hold: boolean;
      readonly edit_window_seconds: number;
      readonly delete_window_seconds: number;
    }[]
  >`
    select
      (
        coalesce(room_policy.legal_hold, false)
        or coalesce((select (metadata->>'legalHold')::boolean from chat_room_settings where org_id = ${message.orgId} and thread_id = ${message.roomId}), false)
        or coalesce(org_policy.legal_hold, false)
      ) as legal_hold,
      coalesce(
        room_policy.edit_window_seconds,
        org_policy.edit_window_seconds,
        86400
      ) as edit_window_seconds,
      coalesce(
        room_policy.delete_window_seconds,
        org_policy.delete_window_seconds,
        86400
      ) as delete_window_seconds
    from (values (1)) as seed(value)
    left join chat_retention_policies room_policy
      on room_policy.org_id = ${message.orgId}
     and room_policy.thread_id = ${message.roomId}
    left join chat_retention_policies org_policy
      on org_policy.org_id = ${message.orgId}
     and org_policy.thread_id is null
  `;
  const policy = rows[0] ?? {
    legal_hold: false,
    edit_window_seconds: 86400,
    delete_window_seconds: 86400,
  };
  const windowSeconds =
    operation === "edit" ? policy.edit_window_seconds : policy.delete_window_seconds;
  if (
    !chatMutationAllowed({
      legalHold: policy.legal_hold,
      windowSeconds,
      sentAt: message.sentAt,
      now: new Date(),
    })
  ) {
    const action = operation === "edit" ? "edited" : "deleted";
    throw new ConflictError(`Chat message cannot be ${action} under its retention policy.`);
  }
}

function expectRetentionPolicy(row: ChatRetentionPolicyRow | undefined): ChatRetentionPolicyRow {
  if (row === undefined) throw new Error("Expected Chat retention policy row.");
  return row;
}

function mapRetentionPolicy(row: ChatRetentionPolicyRow): ChatRetentionPolicyRecord {
  return {
    orgId: row.org_id,
    roomId: row.thread_id,
    retentionDays: row.retention_days,
    editWindowSeconds: row.edit_window_seconds,
    deleteWindowSeconds: row.delete_window_seconds,
    legalHold: row.legal_hold,
    updatedAt: row.updated_at,
  };
}

function mapExportMessage(
  row: ChatExportMessageRow,
): ChatOrganizationExportRecord["messages"][number] {
  const parsedFormat = chatBodyFormatSchema.safeParse(row.body_format);
  return {
    id: row.id,
    roomId: row.thread_id,
    actorId: row.actor_id,
    body: row.body,
    bodyFormat: parsedFormat.success ? parsedFormat.data : "plain",
    sentAt: row.sent_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
  };
}
