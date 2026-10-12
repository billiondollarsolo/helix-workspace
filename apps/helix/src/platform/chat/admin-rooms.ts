import type { ToolDefinition } from "@helix/sdk-types";
import type postgres from "postgres";
import { z } from "zod";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import { requireChatActorInOrg } from "./authorization.js";

const genericObjectJsonSchema = { type: "object", additionalProperties: true } as const;

const listOrganizationRoomsSchema = z.object({
  query: z.string().max(500).optional(),
  limit: z.number().int().positive().max(200).default(100),
  includeAgentOnly: z.boolean().default(false),
});

/** What the Admin console learns about a room: enough to pick it, never its messages. */
const organizationRoomSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["chat_room", "chat_dm"]),
  /** The room's name, or the participants' names for a direct message. */
  name: z.string(),
  privacy: z.enum(["discoverable", "restricted", "private"]),
  memberCount: z.number().int(),
  /** True when the room has members and none of them is a person. */
  agentOnly: z.boolean(),
  updatedAt: z.string(),
});

const organizationRoomsResultSchema = z.object({
  rooms: z.array(organizationRoomSchema),
  privateRoomsVisible: z.boolean(),
  /** Private rooms and direct messages left out because administrators may not see them. */
  hiddenPrivateCount: z.number().int(),
});

type OrganizationRoom = z.output<typeof organizationRoomSchema>;

interface ListRoomsForAdminInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly query?: string | undefined;
  readonly limit?: number | undefined;
  readonly includePrivate: boolean;
  readonly includeAgentOnly: boolean;
}

interface AdminRoomList {
  readonly rooms: readonly OrganizationRoom[];
  readonly hiddenPrivateCount: number;
}

/** One visible room, or a single all-null row carrying only the hidden count. */
type AdminRoomRow = { readonly hidden_private_count: number } & (
  | {
      readonly id: string;
      readonly kind: OrganizationRoom["kind"];
      readonly name: string;
      readonly privacy: OrganizationRoom["privacy"];
      readonly member_count: number;
      readonly agent_only: boolean;
      readonly updated_at: Date;
    }
  | { readonly id: null }
);

/**
 * Rooms across the organization for the Admin console's pickers. Agent-only
 * rooms appear only when asked for; other private rooms and direct messages
 * appear only when the organization lets administrators see them.
 */
export class PostgresChatAdminRoomStore {
  constructor(private readonly sql: postgres.Sql) {}

  list(input: ListRoomsForAdminInput): Promise<AdminRoomList> {
    return withTenantPostgresContext(this.sql, input, async (tx) => {
      await requireChatActorInOrg(tx, input.orgId, input.actorId);
      const query = input.query ?? "";
      // `hidden` is joined to every row so the count survives an empty list.
      const rows = await tx<AdminRoomRow[]>`
        with classified as (
          select
            t.id,
            t.kind,
            t.updated_at,
            coalesce(s.privacy, 'private') as privacy,
            coalesce(nullif(s.name, ''), nullif(t.subject, ''), members.names, '') as name,
            members.member_count,
            members.member_count > 0 and members.person_count = 0 as agent_only,
            t.kind = 'chat_dm' or coalesce(s.privacy, 'private') = 'private' as is_private
          from threads t
          left join chat_room_settings s on s.thread_id = t.id and s.org_id = t.org_id
          cross join lateral (
            select
              count(*)::int as member_count,
              (count(*) filter (where a.type = 'user'))::int as person_count,
              string_agg(coalesce(a.display_name, a.email), ', '
                order by a.display_name nulls last, p.actor_id::text) as names
            from permissions p
            join actors a on a.id = p.actor_id and a.org_id = p.org_id
            where p.org_id = t.org_id and p.resource_type = 'thread' and p.resource_id = t.id
              and p.status = 'active'
              and chat_permission_is_valid(p, ${input.orgId}, p.actor_id, t.id)
          ) members
          where t.org_id = ${input.orgId}
            and t.kind in ('chat_room', 'chat_dm')
        ),
        hidden as (
          select count(*)::int as hidden_private_count
          from classified
          where is_private and not agent_only and not ${input.includePrivate}
        ),
        visible as (
          select *
          from classified
          where (
              case when agent_only then ${input.includeAgentOnly}
              else not is_private or ${input.includePrivate} end
            )
            and (${query} = '' or name ilike ${`%${query}%`})
          order by updated_at desc, id
          limit ${input.limit ?? 100}
        )
        select hidden.hidden_private_count, visible.*
        from hidden
        left join visible on true
        order by visible.updated_at desc nulls last, visible.id
      `;
      return {
        hiddenPrivateCount: rows[0]?.hidden_private_count ?? 0,
        rooms: rows.flatMap((row) =>
          row.id === null
            ? []
            : [
                {
                  id: row.id,
                  kind: row.kind,
                  name: row.name,
                  privacy: row.privacy,
                  memberCount: row.member_count,
                  agentOnly: row.agent_only,
                  updatedAt: row.updated_at.toISOString(),
                },
              ],
        ),
      };
    });
  }
}

export interface ChatAdminRoomToolOptions {
  readonly store: Pick<PostgresChatAdminRoomStore, "list">;
  /** Whether the organization lets administrators see private rooms and direct messages. */
  readonly adminsSeePrivateRooms: (orgId: string) => Promise<boolean>;
}

export function createChatAdminRoomTools(
  options: ChatAdminRoomToolOptions,
): readonly ToolDefinition[] {
  return [
    defineTool<
      z.output<typeof listOrganizationRoomsSchema>,
      z.output<typeof organizationRoomsResultSchema>
    >({
      id: "chat.room.list_organization",
      description:
        "List the organization's chat rooms for an administrator. Private rooms and direct messages are left out unless the organization allows administrators to see them; agent-only rooms are listed on request.",
      permission: "admin.chat",
      sideEffects: "read",
      inputSchema: zodToolSchema(listOrganizationRoomsSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(organizationRoomsResultSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const privateRoomsVisible = await options.adminsSeePrivateRooms(ctx.actor.orgId);
        const listed = await options.store.list({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          query: input.query,
          limit: input.limit,
          includePrivate: privateRoomsVisible,
          includeAgentOnly: input.includeAgentOnly,
        });
        return { ...listed, privateRoomsVisible };
      },
    }),
  ];
}

export function registerChatAdminRoomTools(
  registry: RuntimeToolRegistry,
  options: ChatAdminRoomToolOptions,
): void {
  for (const tool of createChatAdminRoomTools(options)) registry.register(tool);
}
