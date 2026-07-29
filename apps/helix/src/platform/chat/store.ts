import type postgres from "postgres";
import { chatBodyFormatSchema, chatMetadataSchema, type ChatBodyFormat } from "@helix/contracts";
import type { JsonObject } from "@helix/sdk-types";
import { ConflictError } from "../../api/api-error.js";
import { appendChatAudit } from "./audit.js";
import {
  requireActiveChatAttachments,
  requireChatActorInOrg,
  requireChatActorsInOrg,
  requireChatRoomAccess,
  visibleChatAttachments,
  type ChatSql,
} from "./authorization.js";
import { normalizeChatContent, renderChatBodyHtml } from "./content-safety.js";
import { chatMutationAllowed } from "./compliance-policy.js";
import { memberHandleResolver, parseMentions } from "./core/mentions.js";
import { ChatMemberAccessError, ChatMessageNotFoundError, ChatRoomAccessError } from "./errors.js";
import type {
  ChatEnrichmentProjectionStore,
  ChatEnrichmentRecord,
  ChatEnrichmentWrite,
  ChatMessageRecord,
  ChatOrganizationExportRecord,
  ChatPinRecord,
  ChatReactionOperation,
  ChatReactionRecord,
  ChatReadReceiptRecord,
  ChatRetentionPolicyRecord,
  ChatRoomKind,
  ChatRoomRecord,
  ChatSearchHit,
  ChatSearchProjectionStore,
  ChatSearchRequest,
  ChatSearchReactionRecord,
  ChatSearchRecord,
} from "./types.js";

export interface CreateChatRoomInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly kind?: ChatRoomKind | undefined;
  readonly subject?: string | undefined;
  readonly memberActorIds?: readonly string[] | undefined;
  readonly topic?: string | undefined;
  readonly isPrivate?: boolean | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface SendChatMessageInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly roomId: string;
  readonly body: string;
  readonly bodyFormat?: ChatBodyFormat | undefined;
  readonly metadata?: JsonObject | undefined;
  readonly attachmentObjectIds?: readonly string[] | undefined;
  readonly parentMessageId?: string | undefined;
  readonly clientMessageId?: string | undefined;
}

export interface ChatStore {
  createRoom(input: CreateChatRoomInput): Promise<ChatRoomRecord>;
  listRooms(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly query?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly ChatRoomRecord[]>;
  invite(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly actorIds: readonly string[];
    readonly role?: "member" | "admin" | undefined;
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
    readonly before?: Date | undefined;
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
  }): Promise<ChatReactionRecord | null>;
  editMessage(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly messageId: string;
    readonly body: string;
    readonly bodyFormat?: ChatBodyFormat | undefined;
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
    readonly messageId?: string | undefined;
    readonly readAt?: Date | undefined;
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
    readonly before?: Date | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly ChatMessageRecord[]>;
  search(input: ChatSearchRequest): Promise<readonly ChatSearchHit[]>;
  getRoomForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<ChatRoomRecord | null>;
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
  readonly settings_is_private: boolean | null;
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
  readonly metadata: JsonObject;
  readonly attachment_object_ids: readonly string[] | null;
  readonly parent_message_id?: string | null;
  readonly sent_at: Date;
  readonly edited_at: Date | null;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
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
  readonly actor_display_name: string | null;
  readonly actor_email: string | null;
}

type SqlLike = ChatSql;

export class PostgresChatStore
  implements ChatStore, ChatSearchProjectionStore, ChatEnrichmentProjectionStore
{
  constructor(private readonly sql: postgres.Sql) {}

  async createRoom(input: CreateChatRoomInput): Promise<ChatRoomRecord> {
    return this.sql.begin(async (tx) => {
      await requireChatActorInOrg(tx, input.orgId, input.actorId);
      const memberActorIds = [...new Set(input.memberActorIds ?? [])].filter(
        (actorId) => actorId !== input.actorId,
      );
      await requireChatActorsInOrg(tx, input.orgId, memberActorIds);
      const metadata = chatMetadataSchema.parse(input.metadata ?? {}) as JsonObject;
      const threadRows = (await tx`
        insert into threads (org_id, kind, subject, created_by_actor_id, metadata)
        values (
          ${input.orgId},
          ${input.kind ?? "chat_room"},
          ${input.subject ?? null},
          ${input.actorId},
          ${tx.json(toSqlJson(metadata))}
        )
        returning id
      `) as unknown as readonly { readonly id: string }[];
      const roomId = threadRows[0]?.id;
      if (roomId === undefined) {
        throw new Error("Unable to create chat room.");
      }

      await tx`
        insert into chat_room_settings (thread_id, org_id, name, topic, is_private, metadata)
        values (
          ${roomId},
          ${input.orgId},
          ${input.subject ?? null},
          ${input.topic ?? null},
          ${input.isPrivate ?? false},
          ${tx.json(toSqlJson({}))}
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
        metadata: {
          roomId,
          kind: input.kind ?? "chat_room",
          memberCount: memberActorIds.length + 1,
        },
      });

      return expectRoom(await selectRoomForActor(tx, input.orgId, input.actorId, roomId), roomId);
    });
  }

  async invite(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly actorIds: readonly string[];
    readonly role?: "member" | "admin" | undefined;
  }): Promise<{ readonly roomId: string; readonly invitedActorIds: readonly string[] }> {
    const invitedActorIds = [...new Set(input.actorIds)];
    await this.sql.begin(async (tx) => {
      const callerRole = await requireChatRoomAccess(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        roomId: input.roomId,
        roles: ["owner", "admin"],
        lock: true,
      });
      if ((input.role ?? "member") === "admin" && callerRole !== "owner") {
        throw new ChatRoomAccessError();
      }
      await requireChatActorsInOrg(tx, input.orgId, invitedActorIds);
      for (const invitedActorId of invitedActorIds) {
        await grantRoomAccess(tx, {
          orgId: input.orgId,
          roomId: input.roomId,
          actorId: invitedActorId,
          role: input.role ?? "member",
          grantedByActorId: input.actorId,
        });
      }
      await appendChatAudit(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "chat.room.members_invited",
        objectType: "chat.room",
        objectId: input.roomId,
        metadata: {
          roomId: input.roomId,
          invitedActorIds,
          role: input.role ?? "member",
        },
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
      const callerRole = await requireChatRoomAccess(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        roomId: input.roomId,
        roles: ["owner", "admin"],
        lock: true,
      });
      await requireChatActorsInOrg(tx, input.orgId, [input.removedActorId]);
      const targetRows = (await tx`
        select role
        from permissions
        where org_id = ${input.orgId}
          and resource_type = 'thread'
          and resource_id = ${input.roomId}
          and actor_id = ${input.removedActorId}
          and (expires_at is null or expires_at > now())
        for update
      `) as unknown as readonly { readonly role: string }[];
      const targetRole = targetRows[0]?.role;
      if (
        targetRole === undefined ||
        targetRole === "owner" ||
        (targetRole === "admin" && callerRole !== "owner")
      ) {
        throw new ChatMemberAccessError();
      }
      await tx`
        delete from permissions
        where org_id = ${input.orgId}
          and resource_type = 'thread'
          and resource_id = ${input.roomId}
          and actor_id = ${input.removedActorId}
      `;
      await appendChatAudit(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "chat.room.member_removed",
        objectType: "chat.room",
        objectId: input.roomId,
        metadata: { roomId: input.roomId, removedActorId: input.removedActorId },
      });
      await tx`
        insert into outbox (subject, payload)
        values (${"activity.chat.member.removed"}, ${tx.json(
          toSqlJson({
            orgId: input.orgId,
            actorId: input.actorId,
            roomId: input.roomId,
            removedActorId: input.removedActorId,
          }),
        )})
      `;
      return {
        roomId: input.roomId,
        removedActorId: input.removedActorId,
        removed: true,
      };
    });
  }

  async listRooms(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly query?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly ChatRoomRecord[]> {
    await requireChatActorInOrg(this.sql, input.orgId, input.actorId);
    const query = input.query ?? "";
    const rows = (await this.sql`
      select
        t.*,
        s.thread_id as settings_thread_id,
        s.org_id as settings_org_id,
        s.name as settings_name,
        s.topic as settings_topic,
        s.is_private as settings_is_private,
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
          join actors a on a.id = p.actor_id and a.org_id = p.org_id and a.disabled_at is null
          where p.resource_type = 'thread'
            and p.resource_id = t.id
            and p.org_id = ${input.orgId}
            and (p.expires_at is null or p.expires_at > now())
        ) as members
      from threads t
      left join chat_room_settings s on s.thread_id = t.id
      where t.org_id = ${input.orgId}
        and t.kind in ('chat_room', 'chat_dm')
        and (${query} = '' or coalesce(s.name, t.subject, '') ilike ${`%${query}%`} or coalesce(s.topic, '') ilike ${`%${query}%`})
        and exists (
          select 1 from permissions p
          where p.resource_type = 'thread'
            and p.resource_id = t.id
            and p.org_id = ${input.orgId}
            and p.actor_id = ${input.actorId}
            and (p.expires_at is null or p.expires_at > now())
        )
      order by t.updated_at desc
      limit ${input.limit ?? 50}
    `) as unknown as readonly ChatRoomRow[];
    return rows.map(mapRoom);
  }

  async sendMessage(input: SendChatMessageInput): Promise<ChatMessageRecord> {
    return this.sql.begin(async (tx) => {
      const content = normalizeChatContent(input);
      await requireChatRoomAccess(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        roomId: input.roomId,
        lock: true,
      });
      const room = await selectRoomForActor(tx, input.orgId, input.actorId, input.roomId);
      if (room === null) {
        throw new ChatRoomAccessError();
      }
      const attachmentObjectIds = await requireActiveChatAttachments(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        objectIds: input.attachmentObjectIds ?? [],
      });

      if (input.parentMessageId !== undefined) {
        const parent = await selectMessage(tx, input.orgId, input.parentMessageId);
        if (parent === null || parent.roomId !== input.roomId) {
          throw new ChatMessageNotFoundError(input.parentMessageId);
        }
      }

      const mentionIds = parseMentions(content.body, memberHandleResolver(room.members));
      const baseMetadata = {
        ...content.metadata,
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
        ...(input.clientMessageId === undefined ? {} : { clientMessageId: input.clientMessageId }),
      } as JsonObject;
      const validatedMetadata = chatMetadataSchema.parse(baseMetadata) as JsonObject;
      if (input.clientMessageId !== undefined) {
        const existing = await selectClientMessage(tx, {
          orgId: input.orgId,
          roomId: input.roomId,
          actorId: input.actorId,
          clientMessageId: input.clientMessageId,
        });
        if (existing !== null) {
          const hydrated = await hydrateMessagesForActor(tx, input.orgId, input.actorId, [
            existing,
          ]);
          return hydrated[0] ?? mapMessage(existing);
        }
      }

      const messageRows = (await tx`
        insert into messages (
          org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at, parent_message_id
        )
        values (
          ${input.orgId},
          ${input.roomId},
          ${input.actorId},
          'chat',
          ${content.body},
          ${content.bodyFormat},
          ${tx.json(toSqlJson(validatedMetadata))},
          now(),
          ${input.parentMessageId ?? null}
        )
        on conflict do nothing
        returning id
      `) as unknown as readonly { readonly id: string }[];
      const messageId = messageRows[0]?.id;
      if (messageId === undefined && input.clientMessageId !== undefined) {
        const raced = await selectClientMessage(tx, {
          orgId: input.orgId,
          roomId: input.roomId,
          actorId: input.actorId,
          clientMessageId: input.clientMessageId,
        });
        if (raced !== null) {
          const hydrated = await hydrateMessagesForActor(tx, input.orgId, input.actorId, [raced]);
          return hydrated[0] ?? mapMessage(raced);
        }
      }
      if (messageId === undefined) {
        throw new Error("Unable to insert chat message.");
      }

      for (const objectId of attachmentObjectIds) {
        await tx`
          insert into message_attachments (message_id, object_id, disposition)
          values (${messageId}, ${objectId}, 'attachment')
          on conflict do nothing
        `;
      }

      await tx`
        update threads
        set updated_at = now()
        where id = ${input.roomId}
          and org_id = ${input.orgId}
      `;

      await tx`
        insert into outbox (subject, payload)
        values (${"activity.chat.message.created"}, ${tx.json(
          toSqlJson({
            orgId: input.orgId,
            actorId: input.actorId,
            roomId: input.roomId,
            threadId: input.roomId,
            messageId,
            id: messageId,
            attachmentObjectIds,
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
      await appendChatAudit(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "chat.message.sent",
        objectType: "chat.message",
        objectId: messageId,
        metadata: {
          roomId: input.roomId,
          messageId,
          attachmentObjectIds,
          ...(input.parentMessageId === undefined
            ? {}
            : { parentMessageId: input.parentMessageId }),
        },
      });

      const message = await selectMessage(tx, input.orgId, messageId);
      if (message === null) {
        throw new Error("Unable to load inserted chat message.");
      }
      return {
        ...message,
        attachmentObjectIds,
        ...(input.clientMessageId === undefined ? {} : { clientMessageId: input.clientMessageId }),
      };
    });
  }

  async listThreadReplies(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly parentMessageId: string;
    readonly before?: Date | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly ChatMessageRecord[]> {
    await this.requireRoomAccess(input.orgId, input.actorId, input.roomId);
    const rows = (await this.sql`
      select m.*, null::text[] as attachment_object_ids
      from messages m
      where m.org_id = ${input.orgId}
        and m.thread_id = ${input.roomId}
        and m.kind = 'chat'
        and m.deleted_at is null
        and m.parent_message_id = ${input.parentMessageId}
        and (${input.before ?? null}::timestamptz is null or m.sent_at < ${input.before ?? null})
      order by m.sent_at asc
      limit ${input.limit ?? 50}
    `) as unknown as readonly ChatMessageRow[];
    return hydrateMessagesForActor(this.sql, input.orgId, input.actorId, rows);
  }

  async pinMessage(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly messageId: string;
  }): Promise<ChatPinRecord> {
    return this.sql.begin(async (tx) => {
      await requireChatRoomAccess(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        roomId: input.roomId,
        lock: true,
      });
      const message = await selectMessage(tx, input.orgId, input.messageId);
      if (message === null || message.roomId !== input.roomId || message.deletedAt !== null) {
        throw new ChatMessageNotFoundError();
      }
      const rows = (await tx`
        insert into chat_pins (message_id, thread_id, org_id, pinned_by_actor_id)
        values (${input.messageId}, ${input.roomId}, ${input.orgId}, ${input.actorId})
        on conflict (thread_id, message_id) do update
        set pinned_by_actor_id = excluded.pinned_by_actor_id
        returning *
      `) as unknown as readonly ChatPinRow[];
      await touchRoom(tx, input.orgId, input.roomId);
      await tx`
      insert into outbox (subject, payload)
      values (${"activity.chat.message.pinned"}, ${tx.json(
        toSqlJson({
          orgId: input.orgId,
          actorId: input.actorId,
          roomId: input.roomId,
          messageId: input.messageId,
        }),
      )})
    `;
      return mapPin(rows[0]);
    });
  }

  async unpinMessage(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly messageId: string;
  }): Promise<{ readonly ok: true }> {
    await requireChatRoomAccess(this.sql, {
      orgId: input.orgId,
      actorId: input.actorId,
      roomId: input.roomId,
    });
    await this.sql`
      delete from chat_pins
      where thread_id = ${input.roomId}
        and message_id = ${input.messageId}
        and org_id = ${input.orgId}
    `;
    await touchRoom(this.sql, input.orgId, input.roomId);
    await this.sql`
      insert into outbox (subject, payload)
      values (${"activity.chat.message.unpinned"}, ${this.sql.json(
        toSqlJson({
          orgId: input.orgId,
          actorId: input.actorId,
          roomId: input.roomId,
          messageId: input.messageId,
        }),
      )})
    `;
    return { ok: true };
  }

  async listPins(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<readonly ChatPinRecord[]> {
    await this.requireRoomAccess(input.orgId, input.actorId, input.roomId);
    const rows = (await this.sql`
      select *
      from chat_pins
      where org_id = ${input.orgId}
        and thread_id = ${input.roomId}
      order by created_at desc
    `) as unknown as readonly ChatPinRow[];
    return rows.map(mapPin);
  }

  async react(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly messageId: string;
    readonly emoji: string;
    readonly op: ChatReactionOperation;
  }): Promise<ChatReactionRecord | null> {
    const roomId = await this.roomIdForMessage(input.orgId, input.actorId, input.messageId);
    if (input.op === "remove") {
      await this.sql`
        delete from chat_reactions
        where message_id = ${input.messageId}
          and actor_id = ${input.actorId}
          and emoji = ${input.emoji}
      `;
      return null;
    }

    const rows = (await this.sql`
      insert into chat_reactions (message_id, actor_id, org_id, emoji)
      values (${input.messageId}, ${input.actorId}, ${input.orgId}, ${input.emoji})
      on conflict (message_id, actor_id, emoji) do update
      set created_at = chat_reactions.created_at
      returning *
    `) as unknown as readonly ChatReactionRow[];
    await touchRoom(this.sql, input.orgId, roomId);
    return mapReaction(rows[0]);
  }

  async editMessage(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly messageId: string;
    readonly body: string;
    readonly bodyFormat?: ChatBodyFormat | undefined;
  }): Promise<ChatMessageRecord | null> {
    return this.sql.begin(async (tx) => {
      const existing = await selectOwnedMessage(tx, input.orgId, input.actorId, input.messageId);
      if (existing === null) return null;
      await requireChatRoomAccess(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        roomId: existing.roomId,
        lock: true,
      });
      await requireChatMutationAllowed(tx, existing, "edit");
      const content = normalizeChatContent({
        body: input.body,
        bodyFormat: input.bodyFormat ?? existing.bodyFormat,
        metadata: existing.metadata,
      });
      const rows = (await tx`
        update messages
        set
          body = ${content.body},
          body_format = ${content.bodyFormat},
          metadata = ${tx.json(toSqlJson(content.metadata))},
          edited_at = now(),
          updated_at = now()
        where id = ${input.messageId}
          and org_id = ${input.orgId}
          and actor_id = ${input.actorId}
          and kind = 'chat'
          and deleted_at is null
        returning messages.*, null::text[] as attachment_object_ids
      `) as unknown as readonly ChatMessageRow[];
      await touchRoom(tx, input.orgId, existing.roomId);
      await appendChatAudit(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "chat.message.edited",
        objectType: "chat.message",
        objectId: input.messageId,
        metadata: { roomId: existing.roomId, messageId: input.messageId },
      });
      const hydrated = await hydrateMessagesForActor(tx, input.orgId, input.actorId, rows);
      return hydrated[0] ?? null;
    });
  }

  async deleteMessage(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly messageId: string;
  }): Promise<ChatMessageRecord | null> {
    return this.sql.begin(async (tx) => {
      const existing = await selectOwnedMessage(tx, input.orgId, input.actorId, input.messageId);
      if (existing === null) return null;
      await requireChatRoomAccess(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        roomId: existing.roomId,
        lock: true,
      });
      await requireChatMutationAllowed(tx, existing, "delete");
      await tx`delete from message_attachments where message_id = ${input.messageId}`;
      const rows = (await tx`
      update messages
      set
        deleted_at = now(),
        tombstoned_at = now(),
        tombstone_reason = 'user_delete',
        updated_at = now()
      where id = ${input.messageId}
        and org_id = ${input.orgId}
        and actor_id = ${input.actorId}
        and kind = 'chat'
        and deleted_at is null
      returning messages.*, null::text[] as attachment_object_ids
    `) as unknown as readonly ChatMessageRow[];
      const message = rows[0] === undefined ? null : mapMessage(rows[0]);
      if (message !== null) {
        await touchRoom(tx, input.orgId, message.roomId);
        await appendChatAudit(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "chat.message.deleted",
          objectType: "chat.message",
          objectId: input.messageId,
          metadata: { roomId: message.roomId, messageId: input.messageId, reason: "user_delete" },
        });
      }
      return message;
    });
  }

  async markRead(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly messageId?: string | undefined;
    readonly readAt?: Date | undefined;
  }): Promise<ChatReadReceiptRecord> {
    await this.requireRoomAccess(input.orgId, input.actorId, input.roomId);
    if (input.messageId !== undefined) {
      const message = await selectMessage(this.sql, input.orgId, input.messageId);
      if (message === null || message.roomId !== input.roomId || message.deletedAt !== null) {
        throw new ChatMessageNotFoundError();
      }
    }
    const rows = (await this.sql`
      insert into chat_read_receipts (thread_id, actor_id, org_id, last_read_message_id, last_read_at, updated_at)
      values (
        ${input.roomId},
        ${input.actorId},
        ${input.orgId},
        ${input.messageId ?? null},
        ${input.readAt ?? new Date()},
        now()
      )
      on conflict (thread_id, actor_id) do update
      set
        last_read_message_id = excluded.last_read_message_id,
        last_read_at = excluded.last_read_at,
        updated_at = now()
      returning *
    `) as unknown as readonly ChatReadReceiptRow[];
    return mapReadReceipt(rows[0]);
  }

  async listReadReceipts(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<readonly ChatReadReceiptRecord[]> {
    await this.requireRoomAccess(input.orgId, input.actorId, input.roomId);
    const rows = (await this.sql`
      select *
      from chat_read_receipts
      where org_id = ${input.orgId}
        and thread_id = ${input.roomId}
      order by updated_at desc
    `) as unknown as readonly ChatReadReceiptRow[];
    return rows.map((row) => mapReadReceipt(row));
  }

  async listMessages(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly before?: Date | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly ChatMessageRecord[]> {
    await this.requireRoomAccess(input.orgId, input.actorId, input.roomId);
    const rows = (await this.sql`
      select m.*, null::text[] as attachment_object_ids
      from messages m
      where m.org_id = ${input.orgId}
        and m.thread_id = ${input.roomId}
        and m.kind = 'chat'
        and m.deleted_at is null
        and (${input.before ?? null}::timestamptz is null or m.sent_at < ${input.before ?? null})
      order by m.sent_at desc
      limit ${input.limit ?? 50}
    `) as unknown as readonly ChatMessageRow[];
    return hydrateMessagesForActor(this.sql, input.orgId, input.actorId, rows);
  }

  async search(input: ChatSearchRequest): Promise<readonly ChatSearchHit[]> {
    await requireChatActorInOrg(this.sql, input.orgId, input.actorId);
    if (input.roomId !== undefined) {
      await this.requireRoomAccess(input.orgId, input.actorId, input.roomId);
    }
    const rows = (await this.sql`
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
        and exists (
          select 1 from permissions p
          where p.resource_type = 'thread'
            and p.resource_id = t.id
            and p.actor_id = ${input.actorId}
            and p.org_id = ${input.orgId}
            and (p.expires_at is null or p.expires_at > now())
        )
      order by m.sent_at desc
      limit ${input.limit ?? 50}
    `) as unknown as readonly ChatSearchRow[];
    return rows.map(mapSearchHit);
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
          ? ((await tx`
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
            `) as unknown as readonly ChatRetentionPolicyRow[])
          : ((await tx`
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
            `) as unknown as readonly ChatRetentionPolicyRow[]);
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
          ? ((await tx`
              insert into chat_retention_policies (
                org_id, thread_id, legal_hold, changed_by_actor_id
              )
              values (${input.orgId}, null, ${input.enabled}, ${input.actorId})
              on conflict (org_id) where thread_id is null do update set
                legal_hold = excluded.legal_hold,
                changed_by_actor_id = excluded.changed_by_actor_id,
                updated_at = now()
              returning *
            `) as unknown as readonly ChatRetentionPolicyRow[])
          : ((await tx`
              insert into chat_retention_policies (
                org_id, thread_id, legal_hold, changed_by_actor_id
              )
              values (${input.orgId}, ${input.roomId}, ${input.enabled}, ${input.actorId})
              on conflict (org_id, thread_id) where thread_id is not null do update set
                legal_hold = excluded.legal_hold,
                changed_by_actor_id = excluded.changed_by_actor_id,
                updated_at = now()
              returning *
            `) as unknown as readonly ChatRetentionPolicyRow[]);
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
        const roomRows = (await tx`
          select id from threads
          where org_id = ${input.orgId}
            and kind in ('chat_room', 'chat_dm')
            and id = any(${tx.array(roomIds)}::uuid[])
        `) as unknown as readonly { readonly id: string }[];
        if (roomRows.length !== roomIds.length) throw new ChatRoomAccessError();
      }
      const idRows = (await tx`select gen_random_uuid()::text as id`) as unknown as readonly {
        readonly id: string;
      }[];
      const exportId = idRows[0]?.id;
      if (exportId === undefined) throw new Error("Unable to allocate Chat export ID.");
      const rows = (await tx`
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
      `) as unknown as readonly ChatExportMessageRow[];
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
      const candidates = (await tx`
        select m.id, m.thread_id
        from messages m
        where m.org_id = ${input.orgId}
          and m.kind = 'chat'
          and m.deleted_at is null
          and not (
            coalesce(
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
            (select retention_days from chat_retention_policies
             where org_id = m.org_id and thread_id = m.thread_id),
            (select retention_days from chat_retention_policies
             where org_id = m.org_id and thread_id is null),
            2555
          ))
        order by m.sent_at, m.id
        limit ${input.limit ?? 500}
        for update skip locked
      `) as unknown as readonly { readonly id: string; readonly thread_id: string }[];
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

  async getChatSearchRecord(messageId: string): Promise<ChatSearchRecord | null> {
    const rows = (await this.sql`
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
        a.display_name as actor_display_name,
        a.email as actor_email
      from messages m
      join threads t on t.id = m.thread_id
      left join chat_room_settings s on s.thread_id = t.id
      left join actors a on a.id = m.actor_id
      where m.id = ${messageId}
        and m.kind = 'chat'
      limit 1
    `) as unknown as readonly ChatSearchRecordRow[];
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const reactionRows = (await this.sql`
      select message_id, actor_id, org_id, emoji, created_at
      from chat_reactions
      where message_id = ${messageId}
      order by created_at, emoji, actor_id
    `) as unknown as readonly ChatReactionRow[];
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
    try {
      await requireChatRoomAccess(this.sql, input);
    } catch (error) {
      if (error instanceof ChatRoomAccessError) return null;
      throw error;
    }
    return selectRoomForActor(this.sql, input.orgId, input.actorId, input.roomId);
  }

  private async requireRoomAccess(orgId: string, actorId: string, roomId: string): Promise<void> {
    await requireChatRoomAccess(this.sql, { orgId, actorId, roomId });
  }

  private async roomIdForMessage(
    orgId: string,
    actorId: string,
    messageId: string,
  ): Promise<string> {
    const rows = (await this.sql`
      select thread_id
      from messages
      where id = ${messageId}
        and org_id = ${orgId}
        and kind = 'chat'
        and deleted_at is null
      limit 1
    `) as unknown as readonly { readonly thread_id: string }[];
    const roomId = rows[0]?.thread_id;
    if (roomId === undefined) {
      throw new ChatMessageNotFoundError(messageId);
    }
    await this.requireRoomAccess(orgId, actorId, roomId);
    return roomId;
  }
}

async function selectRoomForActor(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  roomId: string,
): Promise<ChatRoomRecord | null> {
  const rows = (await sql`
    select
      t.*,
      s.thread_id as settings_thread_id,
      s.org_id as settings_org_id,
      s.name as settings_name,
      s.topic as settings_topic,
      s.is_private as settings_is_private,
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
        join actors a on a.id = p.actor_id and a.org_id = p.org_id and a.disabled_at is null
        where p.resource_type = 'thread'
          and p.resource_id = t.id
          and p.org_id = ${orgId}
          and (p.expires_at is null or p.expires_at > now())
      ) as members
    from threads t
    left join chat_room_settings s on s.thread_id = t.id
    where t.id = ${roomId}
      and t.org_id = ${orgId}
      and t.kind in ('chat_room', 'chat_dm')
      and t.archived_at is null
      and exists (
        select 1
        from permissions p
        join actors a
          on a.id = p.actor_id
         and a.org_id = p.org_id
         and a.disabled_at is null
        where p.resource_type = 'thread'
          and p.resource_id = t.id
          and p.org_id = ${orgId}
          and p.actor_id = ${actorId}
          and (p.expires_at is null or p.expires_at > now())
      )
    limit 1
  `) as unknown as readonly ChatRoomRow[];
  return rows[0] === undefined ? null : mapRoom(rows[0]);
}

async function selectMessage(
  sql: SqlLike,
  orgId: string,
  messageId: string,
): Promise<ChatMessageRecord | null> {
  const rows = (await sql`
    select
      m.*,
      (select array_agg(ma.object_id::text order by ma.object_id::text) from message_attachments ma where ma.message_id = m.id) as attachment_object_ids
    from messages m
    where m.id = ${messageId}
      and m.org_id = ${orgId}
      and m.kind = 'chat'
    limit 1
  `) as unknown as readonly ChatMessageRow[];
  return rows[0] === undefined ? null : mapMessage(rows[0]);
}

async function selectClientMessage(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly actorId: string;
    readonly clientMessageId: string;
  },
): Promise<ChatMessageRow | null> {
  const rows = (await sql`
    select m.*, null::text[] as attachment_object_ids
    from messages m
    where m.org_id = ${input.orgId}
      and m.thread_id = ${input.roomId}
      and m.actor_id = ${input.actorId}
      and m.kind = 'chat'
      and m.metadata->>'clientMessageId' = ${input.clientMessageId}
    limit 1
  `) as unknown as readonly ChatMessageRow[];
  return rows[0] ?? null;
}

async function selectOwnedMessage(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  messageId: string,
): Promise<ChatMessageRecord | null> {
  const rows = (await sql`
    select m.*, null::text[] as attachment_object_ids
    from messages m
    where m.id = ${messageId}
      and m.org_id = ${orgId}
      and m.actor_id = ${actorId}
      and m.kind = 'chat'
      and m.deleted_at is null
    limit 1
    for update
  `) as unknown as readonly ChatMessageRow[];
  return rows[0] === undefined ? null : mapMessage(rows[0]);
}

async function grantRoomAccess(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly actorId: string;
    readonly role: string;
    readonly grantedByActorId: string;
  },
): Promise<void> {
  await sql`
    insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
    values (${input.orgId}, ${input.actorId}, 'thread', ${input.roomId}, ${input.role}, ${input.grantedByActorId})
    on conflict (org_id, resource_id, actor_id)
      where resource_type = 'thread'
    do update set
      role = excluded.role,
      granted_by_actor_id = excluded.granted_by_actor_id,
      expires_at = null,
      updated_at = now()
  `;
}

async function hydrateMessagesForActor(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  rows: readonly ChatMessageRow[],
): Promise<readonly ChatMessageRecord[]> {
  const attachments = await visibleChatAttachments(sql, {
    orgId,
    actorId,
    messageIds: rows.map((row) => row.id),
  });
  return rows.map((row) =>
    mapMessage({
      ...row,
      attachment_object_ids: attachments.get(row.id) ?? [],
    }),
  );
}

async function touchRoom(sql: SqlLike, orgId: string, roomId: string): Promise<void> {
  await sql`
    update threads
    set updated_at = now()
    where id = ${roomId}
      and org_id = ${orgId}
  `;
}

async function lockChatCompliance(sql: SqlLike, orgId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${orgId}, 77332))`;
}

async function requireChatRoomExistsInOrg(
  sql: SqlLike,
  orgId: string,
  roomId: string,
): Promise<void> {
  const rows = (await sql`
    select 1
    from threads
    where id = ${roomId}
      and org_id = ${orgId}
      and kind in ('chat_room', 'chat_dm')
    limit 1
  `) as unknown as readonly unknown[];
  if (rows.length !== 1) throw new ChatRoomAccessError();
}

async function requireChatMutationAllowed(
  sql: SqlLike,
  message: ChatMessageRecord,
  operation: "edit" | "delete",
): Promise<void> {
  await lockChatCompliance(sql, message.orgId);
  const rows = (await sql`
    select
      (
        coalesce(room_policy.legal_hold, false)
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
  `) as unknown as readonly {
    readonly legal_hold: boolean;
    readonly edit_window_seconds: number;
    readonly delete_window_seconds: number;
  }[];
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

function expectRoom(room: ChatRoomRecord | null, roomId: string): ChatRoomRecord {
  if (room === null) {
    throw new Error(`Unable to load chat room: ${roomId}`);
  }
  return room;
}

function mapRoom(row: ChatRoomRow): ChatRoomRecord {
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
            isPrivate: row.settings_is_private ?? false,
            metadata: row.settings_metadata ?? {},
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
    return typeof record.actorId === "string" && typeof record.role === "string"
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

function mapMessage(row: ChatMessageRow): ChatMessageRecord {
  const clientMessageId =
    typeof row.metadata.clientMessageId === "string" ? row.metadata.clientMessageId : undefined;
  const bodyFormat = chatBodyFormatSchema.safeParse(row.body_format);
  const safeFormat: ChatBodyFormat = bodyFormat.success ? bodyFormat.data : "plain";
  return {
    id: row.id,
    orgId: row.org_id,
    roomId: row.thread_id,
    actorId: row.actor_id,
    body: row.body,
    bodyFormat: safeFormat,
    renderedBodyHtml: renderChatBodyHtml(row.body, safeFormat),
    metadata: row.metadata,
    attachmentObjectIds: row.attachment_object_ids ?? [],
    parentMessageId: row.parent_message_id ?? null,
    ...(clientMessageId === undefined ? {} : { clientMessageId }),
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
  const classification = chatClassification(row.metadata.classification);
  const mentions = chatParticipants(row.metadata.mentions);
  const roomName = row.room_name ?? row.room_subject ?? undefined;
  return {
    id: row.id,
    orgId: row.org_id,
    roomId: row.thread_id,
    ...(roomName === undefined ? {} : { roomName }),
    roomKind: row.room_kind,
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

function toSqlJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
