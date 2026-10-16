import { insertAuditActivity } from "../audit/append.js";
import type postgres from "postgres";
import type { Actor } from "@helix/sdk-types";
import {
  agentRuntimeConfigSchema,
  type AgentRuntime,
  type AgentRuntimeConfig,
  type LiveEvent,
} from "@helix/contracts";
import { requireActorScope } from "../../api/scopes.js";
import { BadRequestError, ConflictError } from "../../api/api-error.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
interface Row {
  actor_id: string;
  config: unknown;
  version: number;
  cursor: string;
  processing_cursor: string | null;
  processing_at: Date | null;
  conversation_id: string | null;
  last_error: string | null;
  last_run_at: Date | null;
  waiting_approval: boolean;
}
function project(r: Row): AgentRuntime {
  const config = agentRuntimeConfigSchema.parse(r.config);
  return {
    actorId: r.actor_id,
    config,
    version: r.version,
    cursor: Number(r.cursor),
    state: r.last_error
      ? "error"
      : !config.enabled || config.mode === "external"
        ? "paused"
        : r.processing_cursor !== null
          ? "working"
          : r.waiting_approval
            ? "waiting_approval"
            : "listening",
    lastError: r.last_error,
    lastRunAt: r.last_run_at?.toISOString() ?? null,
    conversationId: r.conversation_id,
    interrupted: r.processing_cursor !== null,
  };
}
export class AgentRuntimeStore {
  constructor(readonly sql: postgres.Sql) {}
  scoped<T>(actor: Pick<Actor, "id" | "orgId">, run: (tx: postgres.TransactionSql) => Promise<T>) {
    return withTenantPostgresContext(this.sql, { orgId: actor.orgId, actorId: actor.id }, run);
  }
  async list(admin: Actor) {
    return this.scoped(admin, async (tx) =>
      (
        await tx<
          Row[]
        >`select * from agent_runtimes where org_id=${admin.orgId} order by actor_id limit 500`
      ).map(project),
    );
  }
  async get(actor: Pick<Actor, "id" | "orgId">) {
    return this.scoped(actor, async (tx) => {
      const [row] = await tx<
        Row[]
      >`select * from agent_runtimes where actor_id=${actor.id} and org_id=${actor.orgId}`;
      return row ? project(row) : null;
    });
  }
  async configure(admin: Actor, actorId: string, config: AgentRuntimeConfig, reset: boolean) {
    return this.scoped(admin, async (tx) => {
      const [agent] =
        await tx`select id from actors where id=${actorId} and org_id=${admin.orgId} and type='agent' and disabled_at is null`;
      if (!agent) throw new BadRequestError("Choose an active agent in this workspace.");
      if (config.credentialId) {
        const [credential] =
          await tx`select id, scopes from agent_credentials where id=${config.credentialId} and actor_id=${actorId} and org_id=${admin.orgId} and revoked_at is null and (expires_at is null or expires_at>now())`;
        if (!credential)
          throw new BadRequestError("Choose an active credential belonging to this agent.");
        if (config.enabled && config.mode === "helix") {
          const principal: Actor = {
            id: actorId,
            orgId: admin.orgId,
            type: "agent",
            scopes: credential.scopes as string[],
          };
          requireActorScope(principal, "notifications.read");
          requireActorScope(principal, "assistant.write");
        }
      }
      const [old] = await tx<
        Row[]
      >`select * from agent_runtimes where actor_id=${actorId} for update`;
      if (
        reset &&
        !old?.last_error &&
        old?.processing_at &&
        old.processing_at.getTime() > Date.now() - 120000
      )
        throw new ConflictError(
          "Pause this agent and wait for its current turn to stop before resetting.",
        );
      if (
        config.enabled &&
        old?.processing_cursor !== null &&
        old?.processing_cursor !== undefined &&
        !reset
      )
        throw new ConflictError(
          "Review the interrupted turn, then explicitly start from the current inbox. It will not be repeated automatically.",
        );
      // Admin cannot read another actor's inbox under actor RLS; the helper returns only its sequence.
      const [cursor] = await tx<
        { head: string }[]
      >`select helix_agent_event_head(${admin.orgId},${actorId})::text as head`;
      const [row] = await tx<
        Row[]
      >`insert into agent_runtimes(org_id,actor_id,config,cursor) values(${admin.orgId},${actorId},${tx.json(config)},${Number(cursor?.head ?? 0)})
   on conflict(actor_id) do update set config=excluded.config,version=agent_runtimes.version+1,updated_at=now(),
   cursor=case when ${reset} then excluded.cursor else agent_runtimes.cursor end,
   processing_cursor=case when ${reset} then null else agent_runtimes.processing_cursor end,
   processing_at=case when ${reset} then null else agent_runtimes.processing_at end,
   last_error=case when ${reset} then null else agent_runtimes.last_error end returning *`;
      if (!row) throw new Error("Could not save agent hosting.");
      return project(row);
    });
  }
  async candidates(offset = 0) {
    return this.sql<
      { org_id: string; actor_id: string }[]
    >`select * from helix_hosted_agent_ids() limit 20 offset ${offset}`;
  }
  async humanChat(actor: Actor, event: LiveEvent) {
    if (!event.type.startsWith("chat.")) return true;
    return this.scoped(actor, async (tx) => {
      const [row] =
        await tx`select m.id from messages m join actors a on a.id=m.actor_id and a.org_id=m.org_id where m.org_id=${actor.orgId} and m.id=${event.resourceId} and a.type='user' and a.disabled_at is null and m.actor_id<>${actor.id} and m.deleted_at is null`;
      return !!row;
    });
  }
  async begin(actor: Actor, runtime: AgentRuntime, event: LiveEvent) {
    return this.scoped(actor, async (tx) => {
      const rows =
        await tx`update agent_runtimes set processing_cursor=${event.cursor},processing_at=now(),waiting_approval=false,
 window_turns=case when window_started_at<now()-interval '1 hour' then 1 else window_turns+1 end,
 window_started_at=case when window_started_at<now()-interval '1 hour' then now() else window_started_at end
 where actor_id=${actor.id} and org_id=${actor.orgId} and version=${runtime.version} and processing_cursor is null and last_error is null
 and (window_started_at<now()-interval '1 hour' or window_turns<${runtime.config.turnsPerHour}) returning actor_id`;
      if (rows.length === 1)
        await insertAuditActivity(tx, {
          orgId: actor.orgId,
          actorId: actor.id,
          verb: "agent.runtime.started",
          objectType: "actor",
          objectId: actor.id,
          traceId: null,
          metadata: {
            eventId: event.id,
            eventType: event.type,
            credentialId: runtime.config.credentialId,
            modelId: runtime.config.modelId,
          },
        });
      return rows.length === 1;
    });
  }
  async advance(actor: Actor, version: number, cursor: number) {
    await this.scoped(actor, async (tx) => {
      await tx`update agent_runtimes set cursor=greatest(cursor,${cursor}) where actor_id=${actor.id} and org_id=${actor.orgId} and version=${version} and processing_cursor is null`;
    });
  }
  async complete(actor: Actor, event: LiveEvent, conversationId: string, waiting: boolean) {
    await this.scoped(actor, async (tx) => {
      await tx`update agent_runtimes set cursor=greatest(cursor,${event.cursor}),processing_cursor=null,processing_at=null,last_run_at=now(),conversation_id=${conversationId},waiting_approval=${waiting},last_error=null where actor_id=${actor.id} and org_id=${actor.orgId} and processing_cursor=${event.cursor}`;
      await insertAuditActivity(tx, {
        orgId: actor.orgId,
        actorId: actor.id,
        verb: "agent.runtime.completed",
        objectType: "actor",
        objectId: actor.id,
        traceId: null,
        metadata: { eventId: event.id, conversationId, waitingApproval: waiting },
      });
    });
  }
  async fail(actor: Pick<Actor, "id" | "orgId">, message: string) {
    await this.scoped(actor, async (tx) => {
      await tx`update agent_runtimes set last_error=${message.slice(0, 500)},updated_at=now() where actor_id=${actor.id} and org_id=${actor.orgId}`;
    });
  }
}
