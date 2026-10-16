import type { Actor } from "@helix/sdk-types";
import type {
  LiveEvent,
  LiveEventPage,
  PresenceRecord,
  PresenceStatusInput,
} from "@helix/contracts";
import type postgres from "postgres";
import { actorHasScope } from "../../api/scopes.js";
import { BadRequestError, RateLimitedError } from "../../api/api-error.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";

export class LiveStore {
  constructor(private readonly sql: postgres.Sql) {}
  private scoped<T>(actor: Actor, run: (tx: postgres.TransactionSql) => Promise<T>) {
    return withTenantPostgresContext(this.sql, { orgId: actor.orgId, actorId: actor.id }, run);
  }
  async list(actor: Actor, after: number, limit = 100): Promise<LiveEventPage> {
    return this.scoped(actor, async (tx) => {
      const [head] = await tx<{ head: string; floor: string }[]>`select
        coalesce((select next_sequence from actor_event_state where actor_id=${actor.id}),0)::text as head,
        coalesce((select min(sequence) from actor_events where actor_id=${actor.id} and created_at>=now()-interval '7 days'),
          (select next_sequence+1 from actor_event_state where actor_id=${actor.id}),1)::text as floor`;
      const latestCursor = Number(head?.head ?? 0),
        floor = Number(head?.floor ?? 1);
      if (after > latestCursor || after < floor - 1)
        return {
          events: [],
          cursor: latestCursor,
          latestCursor,
          hasMore: false,
          resetRequired: true,
        };
      const rows = await tx<
        {
          sequence: string;
          type: LiveEvent["type"];
          resource_id: string;
          parent_id: string | null;
          created_at: Date;
          visible: boolean;
        }[]
      >`
        select e.*,e.sequence::text, case
          when e.type like 'chat.%' then exists(select 1 from messages m where m.org_id=e.org_id and m.id=e.resource_id and m.deleted_at is null
            and helix_chat_message_visible_to(m.org_id,${actor.id},m.thread_id,m.sent_at)
            and not exists(select 1 from helix_chat_presence_blocked_actor_ids(e.org_id,${actor.id},array[m.actor_id])))
          when e.type='mail.received' then exists(select 1 from messages m where m.org_id=e.org_id and m.id=e.resource_id and m.deleted_at is null and helix_can_read_mail_message(m.org_id,m.id))
          when e.type like 'approval.%' then exists(select 1 from pending_actions p where p.org_id=e.org_id and p.id=e.resource_id and (${actor.id}=p.actor_id or ${actor.id}=p.approval_owner_actor_id))
          else exists(select 1 from notifications n where n.org_id=e.org_id and n.actor_id=${actor.id} and n.id=e.resource_id)
        end as visible
        from actor_events e where e.actor_id=${actor.id} and e.sequence>${after} and e.sequence<=${latestCursor}
          and e.created_at>=now()-interval '7 days' order by e.sequence limit ${Math.min(100, Math.max(1, limit))}`;
      const events = rows
        .filter(
          (r) =>
            r.visible &&
            actorHasScope(
              actor,
              r.type.startsWith("chat.")
                ? "chat.read"
                : r.type === "mail.received"
                  ? "mail.read"
                  : "notifications.read",
            ),
        )
        .map((r) => ({
          id: `${actor.id}:${r.sequence}`,
          cursor: Number(r.sequence),
          type: r.type,
          resourceId: r.resource_id,
          parentId: r.parent_id,
          createdAt: r.created_at.toISOString(),
        }));
      const cursor = Number(rows.at(-1)?.sequence ?? after);
      return { events, cursor, latestCursor, hasMore: cursor < latestCursor, resetRequired: false };
    });
  }
  async status(actor: Actor, ids: readonly string[]): Promise<PresenceRecord[]> {
    return this.scoped(actor, async (tx) => {
      const rows = await tx<
        {
          actor_id: string;
          availability: PresenceRecord["availability"];
          status_text: string;
          emoji: string;
          expires_at: Date | null;
          state: PresenceRecord["state"];
          seen_at: Date | null;
        }[]
      >`
        select a.id as actor_id,
          case when s.expires_at<=now() then 'available' else coalesce(s.availability,'available') end as availability,
          case when s.expires_at<=now() then '' else coalesce(s.status_text,'') end as status_text,
          case when s.expires_at<=now() then '' else coalesce(s.emoji,'') end as emoji,
          case when s.expires_at>now() then s.expires_at else null end as expires_at,
          coalesce(c.state,'offline') as state, c.seen_at
        from actors a left join actor_status s on s.org_id=a.org_id and s.actor_id=a.id
        left join lateral(select state,seen_at from actor_presence_connections p where p.org_id=a.org_id and p.actor_id=a.id
          and seen_at>now()-interval '60 seconds'
          order by case state when 'working' then 0 when 'waiting_approval' then 1 when 'active' then 2 else 3 end,seen_at desc limit 1) c on true
        where a.org_id=${actor.orgId} and a.id=any(${tx.array([...ids])}::uuid[]) and helix_presence_visible(a.org_id,${actor.id},a.id)`;
      return rows.map((r) => {
        const hidden = r.availability === "invisible" && r.actor_id !== actor.id;
        return {
          actorId: r.actor_id,
          availability: hidden ? "away" : r.availability,
          text: r.status_text,
          emoji: r.emoji,
          expiresAt: r.expires_at?.toISOString() ?? null,
          connected: !hidden && r.state !== "offline",
          state: hidden ? "offline" : r.state,
          lastSeenAt: hidden ? null : (r.seen_at?.toISOString() ?? null),
        };
      });
    });
  }
  async setStatus(actor: Actor, input: PresenceStatusInput) {
    if (
      input.expiresAt !== null &&
      (Date.parse(input.expiresAt) <= Date.now() ||
        Date.parse(input.expiresAt) > Date.now() + 30 * 86400000)
    )
      throw new BadRequestError("Status expiry must be in the next 30 days.");
    await this.scoped(actor, async (tx) => {
      await tx`insert into actor_status(org_id,actor_id,availability,status_text,emoji,expires_at)
      values(${actor.orgId},${actor.id},${input.availability},${input.text},${input.emoji},${input.expiresAt})
      on conflict(actor_id) do update set availability=excluded.availability,status_text=excluded.status_text,emoji=excluded.emoji,expires_at=excluded.expires_at`;
    });
    return (await this.status(actor, [actor.id]))[0];
  }
  async heartbeat(
    actor: Actor,
    connectionId: string,
    state: "idle" | "active" | "working" | "waiting_approval",
    disconnect = false,
  ) {
    return this.scoped(actor, async (tx) => {
      // Serialize the per-actor connection cap without holding a lock for a stream's lifetime.
      await tx`select pg_advisory_xact_lock(hashtextextended(${`presence:${actor.id}`},0))`;
      await tx`delete from actor_presence_connections where actor_id=${actor.id} and (seen_at<now()-interval '2 minutes' or (connection_id=${connectionId} and ${disconnect}))`;
      if (disconnect) return;
      const [count] = await tx<
        { count: number; existing: boolean }[]
      >`select count(*)::int as count,coalesce(bool_or(connection_id=${connectionId}),false) as existing from actor_presence_connections where actor_id=${actor.id}`;
      if (!count?.existing && (count?.count ?? 0) >= 8)
        throw new RateLimitedError("Too many presence connections. Close another tab or listener.");
      await tx`insert into actor_presence_connections(org_id,actor_id,connection_id,state) values(${actor.orgId},${actor.id},${connectionId},${state})
        on conflict(actor_id,connection_id) do update set state=excluded.state,seen_at=now()`;
    });
  }
}
