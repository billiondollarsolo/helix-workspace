import {
  type ChatMentionsListResult,
  chatMentionsListInputSchema,
  chatMentionsListResultSchema,
  type ChatUnreadListResult,
  chatUnreadListInputSchema,
  chatUnreadListResultSchema,
} from "@helix/contracts";
import type { ToolDefinition } from "@helix/sdk-types";
import type postgres from "postgres";
import type { z } from "zod";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";

const genericObjectJsonSchema = { type: "object", additionalProperties: true } as const;

interface Member {
  readonly orgId: string;
  readonly actorId: string;
}

interface UnreadRow {
  readonly room_id: string;
  readonly unread_count: number;
  readonly mention_count: number;
  readonly last_message_at: Date | null;
  readonly last_read_at: Date | null;
}

interface MentionRow {
  readonly room_id: string;
  readonly room_name: string;
  readonly message_id: string;
  readonly parent_message_id: string | null;
  readonly actor_id: string | null;
  readonly actor_display_name: string | null;
  readonly body: string;
  readonly sent_at: Date;
  readonly unread: boolean;
}

/**
 * Home and Mentions projections: per-conversation unread and mention counts
 * after the actor's read marker, and the messages that @mention the actor.
 * Only conversations the actor belongs to and messages their history policy
 * lets them see are counted.
 */
export class PostgresChatInboxStore {
  constructor(private readonly sql: postgres.Sql) {}

  unread(input: Member): Promise<ChatUnreadListResult> {
    return withTenantPostgresContext(this.sql, input, async (tx) => {
      const mention = tx.json([{ id: input.actorId }]);
      const rows = await tx<UnreadRow[]>`
        select
          room.id as room_id,
          count(message.id)::int as unread_count,
          count(message.id) filter (where message.metadata->'mentions' @> ${mention}::jsonb)::int
            as mention_count,
          (
            select max(latest.sent_at) from messages latest
            where latest.thread_id = room.id and latest.org_id = room.org_id
              and latest.kind = 'chat' and latest.deleted_at is null
          ) as last_message_at,
          receipt.last_read_at
        from threads room
        left join chat_read_receipts receipt
          on receipt.thread_id = room.id and receipt.org_id = room.org_id
         and receipt.actor_id = ${input.actorId}
        left join messages message
          on message.thread_id = room.id and message.org_id = room.org_id
         and message.kind = 'chat' and message.deleted_at is null
         and message.actor_id is distinct from ${input.actorId}
         and message.chat_room_sequence > coalesce(receipt.last_read_sequence, 0)
         and helix_chat_message_visible_to(${input.orgId}, ${input.actorId}, room.id, message.sent_at)
        where room.org_id = ${input.orgId}
          and room.kind in ('chat_room', 'chat_dm')
          -- Narrow to the actor's active thread grants through
          -- permissions_chat_validity_idx before the threads RLS policy runs;
          -- chat_permission_is_valid below stays the authoritative check.
          and room.id = any(array(
            select candidate.resource_id from permissions candidate
            where candidate.org_id = ${input.orgId}
              and candidate.actor_id = ${input.actorId}
              and candidate.resource_type = 'thread'
              and candidate.status = 'active'
          ))
          and exists (
            select 1 from permissions access_grant
            where access_grant.org_id = ${input.orgId}
              and access_grant.actor_id = ${input.actorId}
              and access_grant.resource_type = 'thread'
              and access_grant.resource_id = room.id
              and access_grant.status = 'active'
              and chat_permission_is_valid(access_grant, ${input.orgId}, ${input.actorId}, room.id)
          )
        group by room.id, room.org_id, receipt.last_read_at
        order by last_message_at desc nulls last, room.id
      `;
      return {
        rooms: rows.map((row) => ({
          roomId: row.room_id,
          unreadCount: row.unread_count,
          mentionCount: row.mention_count,
          lastMessageAt: row.last_message_at?.toISOString() ?? null,
          lastReadAt: row.last_read_at?.toISOString() ?? null,
        })),
        totalUnread: rows.reduce((total, row) => total + row.unread_count, 0),
        totalMentions: rows.reduce((total, row) => total + row.mention_count, 0),
      };
    });
  }

  mentions(
    input: Member & { readonly limit: number; readonly before?: Date | undefined },
  ): Promise<ChatMentionsListResult> {
    return withTenantPostgresContext(this.sql, input, async (tx) => {
      const rows = await tx<MentionRow[]>`
        select
          room.id as room_id,
          coalesce(settings.name, room.subject, '') as room_name,
          message.id as message_id,
          message.parent_message_id,
          message.actor_id,
          author.display_name as actor_display_name,
          message.body,
          message.sent_at,
          message.chat_room_sequence > coalesce(receipt.last_read_sequence, 0) as unread
        from messages message
        join threads room on room.id = message.thread_id and room.org_id = message.org_id
        left join chat_room_settings settings
          on settings.thread_id = room.id and settings.org_id = room.org_id
        left join actors author on author.id = message.actor_id and author.org_id = message.org_id
        left join chat_read_receipts receipt
          on receipt.thread_id = room.id and receipt.org_id = room.org_id
         and receipt.actor_id = ${input.actorId}
        where message.org_id = ${input.orgId}
          and message.kind = 'chat'
          and message.deleted_at is null
          and message.metadata->'mentions' @> ${tx.json([{ id: input.actorId }])}::jsonb
          and message.actor_id is distinct from ${input.actorId}
          and (${input.before ?? null}::timestamptz is null or message.sent_at < ${input.before ?? null}::timestamptz)
          and room.kind in ('chat_room', 'chat_dm')
          and exists (
            select 1 from permissions access_grant
            where access_grant.org_id = ${input.orgId}
              and access_grant.actor_id = ${input.actorId}
              and access_grant.resource_type = 'thread'
              and access_grant.resource_id = room.id
              and access_grant.status = 'active'
              and chat_permission_is_valid(access_grant, ${input.orgId}, ${input.actorId}, room.id)
          )
          and helix_chat_message_visible_to(${input.orgId}, ${input.actorId}, room.id, message.sent_at)
        order by message.sent_at desc, message.id desc
        limit ${input.limit + 1}
      `;
      const page = rows.slice(0, input.limit);
      return {
        mentions: page.map((row) => ({
          roomId: row.room_id,
          roomName: row.room_name,
          messageId: row.message_id,
          parentMessageId: row.parent_message_id,
          actorId: row.actor_id,
          actorDisplayName: row.actor_display_name,
          preview: row.body.slice(0, 240),
          sentAt: row.sent_at.toISOString(),
          unread: row.unread,
        })),
        nextBefore: rows.length > input.limit ? (page.at(-1)?.sent_at.toISOString() ?? null) : null,
      };
    });
  }
}

function createChatInboxTools(
  store: Pick<PostgresChatInboxStore, "unread" | "mentions">,
): readonly ToolDefinition[] {
  return [
    defineTool<z.output<typeof chatUnreadListInputSchema>, ChatUnreadListResult>({
      id: "chat.unread.list",
      description:
        "Unread and @mention counts for every conversation you belong to, most recently active first.",
      permission: "chat.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(chatUnreadListInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(chatUnreadListResultSchema, genericObjectJsonSchema),
      handler: (_input, ctx) => store.unread({ orgId: ctx.actor.orgId, actorId: ctx.actor.id }),
    }),
    defineTool<z.output<typeof chatMentionsListInputSchema>, ChatMentionsListResult>({
      id: "chat.mentions.list",
      description:
        "Messages that @mention you across your conversations, newest first. Page with `before` set to the previous `nextBefore`.",
      permission: "chat.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(chatMentionsListInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(chatMentionsListResultSchema, genericObjectJsonSchema),
      handler: (input, ctx) =>
        store.mentions({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          limit: input.limit,
          ...(input.before === undefined ? {} : { before: new Date(input.before) }),
        }),
    }),
  ];
}

export function registerChatInboxTools(
  registry: RuntimeToolRegistry,
  options: { readonly store: Pick<PostgresChatInboxStore, "unread" | "mentions"> },
): void {
  for (const tool of createChatInboxTools(options.store)) registry.register(tool);
}
