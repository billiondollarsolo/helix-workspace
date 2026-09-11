import { randomBytes } from "node:crypto";
import type postgres from "postgres";
import {
  parseAgentDefenderReceiveMode,
  type AgentDefenderPolicy,
  type AgentDefenderReceiveMode,
} from "./defender-policy.js";

interface PolicyRow {
  readonly org_id: string;
  readonly actor_id: string;
  readonly owner_actor_id: string;
  readonly receive_mode: string;
  readonly loop_enabled: boolean;
  readonly allowed_senders: readonly string[] | null;
  readonly allow_send: boolean;
}

interface HoldRow {
  readonly agent_actor_id: string;
  readonly thread_id: string;
  readonly held_at: Date;
  readonly subject: string;
  readonly from_address: string;
}

interface JobRow {
  readonly id: string;
  readonly org_id: string;
  readonly agent_actor_id: string;
  readonly message_id: string;
  readonly thread_id: string;
  readonly status: string;
  readonly attempts: number;
  readonly canary: string;
}

export interface AgentDefenderHold {
  readonly agentActorId: string;
  readonly threadId: string;
  readonly heldAt: string;
  readonly subject: string;
  readonly fromAddress: string;
}

export interface AgentDefenderJob {
  readonly id: string;
  readonly orgId: string;
  readonly agentActorId: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly canary: string;
  readonly attempts: number;
}

function mapPolicy(row: PolicyRow): AgentDefenderPolicy {
  return {
    orgId: row.org_id,
    actorId: row.actor_id,
    ownerActorId: row.owner_actor_id,
    receiveMode: parseAgentDefenderReceiveMode(row.receive_mode),
    loopEnabled: row.loop_enabled,
    allowedSenders: row.allowed_senders ?? [],
    allowSend: row.allow_send,
  };
}

export class PostgresAgentDefenderStore {
  constructor(private readonly sql: postgres.Sql) {}

  async getPolicy(orgId: string, actorId: string): Promise<AgentDefenderPolicy | null> {
    const rows = await this.sql<PolicyRow[]>`
      select org_id, actor_id, owner_actor_id, receive_mode, loop_enabled, allowed_senders, allow_send
      from agent_defender_policies
      where org_id = ${orgId} and actor_id = ${actorId}
      limit 1
    `;
    const row = rows[0];
    return row === undefined ? null : mapPolicy(row);
  }

  async listPoliciesForOwner(
    orgId: string,
    ownerActorId: string,
  ): Promise<readonly AgentDefenderPolicy[]> {
    const rows = await this.sql<PolicyRow[]>`
      select org_id, actor_id, owner_actor_id, receive_mode, loop_enabled, allowed_senders, allow_send
      from agent_defender_policies
      where org_id = ${orgId} and owner_actor_id = ${ownerActorId}
      order by updated_at desc
    `;
    return rows.map(mapPolicy);
  }

  async upsertPolicy(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly ownerActorId: string;
    readonly receiveMode: AgentDefenderReceiveMode;
    readonly loopEnabled: boolean;
    readonly allowedSenders: readonly string[];
    readonly allowSend: boolean;
  }): Promise<AgentDefenderPolicy> {
    const rows = await this.sql<PolicyRow[]>`
      insert into agent_defender_policies (
        org_id, actor_id, owner_actor_id, receive_mode, loop_enabled, allowed_senders, allow_send
      ) values (
        ${input.orgId},
        ${input.actorId},
        ${input.ownerActorId},
        ${input.receiveMode},
        ${input.loopEnabled},
        ${this.sql.array([...input.allowedSenders])},
        ${input.allowSend}
      )
      on conflict (org_id, actor_id) do update set
        owner_actor_id = excluded.owner_actor_id,
        receive_mode = excluded.receive_mode,
        loop_enabled = excluded.loop_enabled,
        allowed_senders = excluded.allowed_senders,
        allow_send = excluded.allow_send,
        updated_at = statement_timestamp()
      returning org_id, actor_id, owner_actor_id, receive_mode, loop_enabled, allowed_senders, allow_send
    `;
    const row = rows[0];
    if (row === undefined) throw new Error("Failed to save Agent Defender policy.");
    return mapPolicy(row);
  }

  async listHolds(orgId: string, operatorActorId: string): Promise<readonly AgentDefenderHold[]> {
    const rows = await this.sql<HoldRow[]>`
      select agent_actor_id, thread_id, held_at, subject, from_address
      from helix_agent_defender_list_holds(${orgId}, ${operatorActorId})
    `;
    return rows.map((row) => ({
      agentActorId: row.agent_actor_id,
      threadId: row.thread_id,
      heldAt: row.held_at.toISOString(),
      subject: row.subject,
      fromAddress: row.from_address,
    }));
  }

  async decideHold(input: {
    readonly orgId: string;
    readonly operatorActorId: string;
    readonly agentActorId: string;
    readonly threadId: string;
    readonly action: "release" | "junk";
  }): Promise<boolean> {
    const rows = await this.sql<{ readonly helix_agent_defender_set_hold: boolean }[]>`
      select helix_agent_defender_set_hold(
        ${input.orgId},
        ${input.operatorActorId},
        ${input.agentActorId},
        ${input.threadId},
        ${input.action}
      )
    `;
    return rows[0]?.helix_agent_defender_set_hold === true;
  }

  async enqueueLoopJob(input: {
    readonly orgId: string;
    readonly agentActorId: string;
    readonly messageId: string;
    readonly threadId: string;
  }): Promise<void> {
    await this.sql`
      insert into agent_defender_jobs (
        org_id, agent_actor_id, message_id, thread_id, canary
      ) values (
        ${input.orgId},
        ${input.agentActorId},
        ${input.messageId},
        ${input.threadId},
        ${randomBytes(16).toString("hex")}
      )
      on conflict (org_id, agent_actor_id, message_id) do nothing
    `;
  }

  async claimDue(now: Date, limit: number): Promise<readonly AgentDefenderJob[]> {
    return this.sql.begin(async (sql) => {
      const rows = await sql<JobRow[]>`
        update agent_defender_jobs job
        set status = 'running', attempts = job.attempts + 1
        from (
          select id
          from agent_defender_jobs
          where status = 'pending' and created_at <= ${now}
          order by created_at
          limit ${limit}
          for update skip locked
        ) due
        where job.id = due.id
        returning job.id, job.org_id, job.agent_actor_id, job.message_id, job.thread_id,
          job.status, job.attempts, job.canary
      `;
      return rows.map((row) => ({
        id: row.id,
        orgId: row.org_id,
        agentActorId: row.agent_actor_id,
        messageId: row.message_id,
        threadId: row.thread_id,
        canary: row.canary,
        attempts: row.attempts,
      }));
    });
  }

  async markJob(
    id: string,
    result: { readonly status: "done" | "skipped" | "failed" | "pending"; readonly error?: string },
  ): Promise<void> {
    await this.sql`
      update agent_defender_jobs
      set status = ${result.status},
        last_error = ${result.error ?? null},
        processed_at = case when ${result.status} = 'pending' then processed_at else statement_timestamp() end
      where id = ${id}
    `;
  }
}
