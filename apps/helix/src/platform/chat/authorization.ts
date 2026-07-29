import type postgres from "postgres";
import { ChatAttachmentAccessError, ChatMemberAccessError, ChatRoomAccessError } from "./errors.js";

export type ChatRoomRole = "owner" | "admin" | "member";
export type ChatSql = postgres.Sql | postgres.TransactionSql;

interface RoomAccessRow {
  readonly role: string;
}

/** The shared actor/tenant boundary used before every Chat operation. */
export async function requireChatActorInOrg(
  sql: ChatSql,
  orgId: string,
  actorId: string,
): Promise<void> {
  const rows = (await sql`
    select 1
    from actors
    where id = ${actorId}
      and org_id = ${orgId}
      and disabled_at is null
    limit 1
  `) as unknown as readonly { readonly "?column?": number }[];
  if (rows.length !== 1) {
    throw new ChatRoomAccessError();
  }
}

/**
 * Central room authorization. Room creation always installs an owner
 * permission, so creator identity is deliberately not an access bypass.
 */
export async function requireChatRoomAccess(
  sql: ChatSql,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly roles?: readonly ChatRoomRole[] | undefined;
    readonly lock?: boolean | undefined;
  },
): Promise<ChatRoomRole> {
  const rows =
    input.lock === true
      ? ((await sql`
          select p.role
          from threads t
          join permissions p
            on p.org_id = t.org_id
           and p.resource_type = 'thread'
           and p.resource_id = t.id
           and p.actor_id = ${input.actorId}
           and (p.expires_at is null or p.expires_at > now())
          join actors a
            on a.id = p.actor_id
           and a.org_id = t.org_id
           and a.disabled_at is null
          where t.id = ${input.roomId}
            and t.org_id = ${input.orgId}
            and t.kind in ('chat_room', 'chat_dm')
            and t.archived_at is null
          limit 1
          for key share of t, p
        `) as unknown as readonly RoomAccessRow[])
      : ((await sql`
          select p.role
          from threads t
          join permissions p
            on p.org_id = t.org_id
           and p.resource_type = 'thread'
           and p.resource_id = t.id
           and p.actor_id = ${input.actorId}
           and (p.expires_at is null or p.expires_at > now())
          join actors a
            on a.id = p.actor_id
           and a.org_id = t.org_id
           and a.disabled_at is null
          where t.id = ${input.roomId}
            and t.org_id = ${input.orgId}
            and t.kind in ('chat_room', 'chat_dm')
            and t.archived_at is null
          limit 1
        `) as unknown as readonly RoomAccessRow[]);
  const rawRole = rows[0]?.role;
  const role: ChatRoomRole =
    rawRole === "owner" ? "owner" : rawRole === "admin" ? "admin" : "member";
  if (rawRole === undefined || (input.roles !== undefined && !input.roles.includes(role))) {
    throw new ChatRoomAccessError();
  }
  return role;
}

/** Validates invite/remove targets without revealing cross-tenant actor IDs. */
export async function requireChatActorsInOrg(
  sql: ChatSql,
  orgId: string,
  actorIds: readonly string[],
): Promise<void> {
  const uniqueActorIds = [...new Set(actorIds)];
  if (uniqueActorIds.length === 0) return;
  const rows = (await sql`
    select id::text as id
    from actors
    where org_id = ${orgId}
      and id = any(${sql.array(uniqueActorIds)}::uuid[])
      and disabled_at is null
    for key share
  `) as unknown as readonly { readonly id: string }[];
  if (rows.length !== uniqueActorIds.length) {
    throw new ChatMemberAccessError();
  }
}

/**
 * Requires every attachment to be active and currently visible to the sender.
 * The object locks keep scan/quarantine/delete transitions from racing a send.
 */
export async function requireActiveChatAttachments(
  sql: ChatSql,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectIds: readonly string[];
  },
): Promise<readonly string[]> {
  const objectIds = [...new Set(input.objectIds)];
  if (objectIds.length === 0) return [];
  const rows = (await sql`
    select o.id::text as id
    from objects o
    where o.org_id = ${input.orgId}
      and o.id = any(${sql.array(objectIds)}::uuid[])
      and o.deleted_at is null
      and o.upload_state = 'active'
      and (
        o.owner_actor_id = ${input.actorId}
        or exists (
          select 1
          from permissions p
          where p.org_id = o.org_id
            and p.resource_type = 'object'
            and p.resource_id = o.id
            and p.actor_id = ${input.actorId}
            and (p.expires_at is null or p.expires_at > now())
        )
      )
    for key share of o
  `) as unknown as readonly { readonly id: string }[];
  if (rows.length !== objectIds.length) {
    throw new ChatAttachmentAccessError();
  }
  return objectIds;
}

/**
 * Read-time filtering makes revocation, deletion, and malware quarantine take
 * effect even for attachments referenced by older messages.
 */
export async function visibleChatAttachments(
  sql: ChatSql,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly messageIds: readonly string[];
  },
): Promise<ReadonlyMap<string, readonly string[]>> {
  const messageIds = [...new Set(input.messageIds)];
  if (messageIds.length === 0) return new Map();
  const rows = (await sql`
    select ma.message_id::text as message_id, ma.object_id::text as object_id
    from message_attachments ma
    join messages m
      on m.id = ma.message_id
     and m.org_id = ${input.orgId}
    join objects o
      on o.id = ma.object_id
     and o.org_id = m.org_id
     and o.deleted_at is null
     and o.upload_state = 'active'
    where ma.message_id = any(${sql.array(messageIds)}::uuid[])
      and (
        o.owner_actor_id = ${input.actorId}
        or exists (
          select 1
          from permissions p
          where p.org_id = o.org_id
            and p.resource_type = 'object'
            and p.resource_id = o.id
            and p.actor_id = ${input.actorId}
            and (p.expires_at is null or p.expires_at > now())
        )
      )
    order by ma.message_id, ma.object_id
  `) as unknown as readonly {
    readonly message_id: string;
    readonly object_id: string;
  }[];
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const ids = result.get(row.message_id) ?? [];
    ids.push(row.object_id);
    result.set(row.message_id, ids);
  }
  return result;
}
