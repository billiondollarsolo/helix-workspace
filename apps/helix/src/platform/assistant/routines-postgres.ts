import type { Actor } from "@helix/sdk-types";
import type postgres from "postgres";
import { nextRunAt, type AssistantRoutine, type AssistantRoutineStore } from "./routines.js";

interface RoutineRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_id: string;
  readonly conversation_id: string | null;
  readonly name: string;
  readonly prompt: string;
  readonly interval_minutes: number;
  readonly enabled: boolean;
  readonly next_run_at: Date;
  readonly last_run_at: Date | null;
  readonly last_error: string | null;
  readonly created_at: Date;
}

function rowToRoutine(row: RoutineRow): AssistantRoutine {
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    name: row.name,
    prompt: row.prompt,
    intervalMinutes: row.interval_minutes,
    enabled: row.enabled,
    conversationId: row.conversation_id,
    nextRunAt: row.next_run_at.toISOString(),
    lastRunAt: row.last_run_at?.toISOString() ?? null,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
  };
}

export class PostgresRoutineStore implements AssistantRoutineStore {
  constructor(private readonly sql: postgres.Sql) {}

  async create(input: {
    readonly actor: Actor;
    readonly name: string;
    readonly prompt: string;
    readonly intervalMinutes: number;
    readonly conversationId?: string;
  }): Promise<AssistantRoutine> {
    const rows = await this.sql<RoutineRow[]>`
      insert into assistant_routines (
        org_id, actor_id, conversation_id, name, prompt, interval_minutes, next_run_at
      ) values (
        ${input.actor.orgId},
        ${input.actor.id},
        ${input.conversationId ?? null},
        ${input.name},
        ${input.prompt},
        ${input.intervalMinutes},
        ${nextRunAt(new Date(), input.intervalMinutes)}
      )
      returning id, org_id, actor_id, conversation_id, name, prompt, interval_minutes, enabled,
        next_run_at, last_run_at, last_error, created_at
    `;
    const row = rows[0];
    if (row === undefined) throw new Error("Failed to create routine.");
    return rowToRoutine(row);
  }

  async list(actor: Actor): Promise<readonly AssistantRoutine[]> {
    const rows = await this.sql<RoutineRow[]>`
      select id, org_id, actor_id, conversation_id, name, prompt, interval_minutes, enabled,
        next_run_at, last_run_at, last_error, created_at
      from assistant_routines
      where org_id = ${actor.orgId} and actor_id = ${actor.id}
      order by created_at desc
    `;
    return rows.map(rowToRoutine);
  }

  async setEnabled(actor: Actor, id: string, enabled: boolean): Promise<AssistantRoutine | null> {
    const rows = await this.sql<RoutineRow[]>`
      update assistant_routines
      set enabled = ${enabled}, updated_at = now()
      where id = ${id} and org_id = ${actor.orgId} and actor_id = ${actor.id}
      returning id, org_id, actor_id, conversation_id, name, prompt, interval_minutes, enabled,
        next_run_at, last_run_at, last_error, created_at
    `;
    const row = rows[0];
    return row === undefined ? null : rowToRoutine(row);
  }

  async claimDue(now: Date, limit: number): Promise<readonly AssistantRoutine[]> {
    return this.sql.begin(async (sql) => {
      const rows = await sql<RoutineRow[]>`
        select id, org_id, actor_id, conversation_id, name, prompt, interval_minutes, enabled,
          next_run_at, last_run_at, last_error, created_at
        from assistant_routines
        where enabled and next_run_at <= ${now}
        order by next_run_at
        limit ${limit}
        for update skip locked
      `;
      return rows.map(rowToRoutine);
    });
  }

  async markRun(
    id: string,
    result: { readonly error?: string; readonly nextRunAt: Date },
  ): Promise<void> {
    await this.sql`
      update assistant_routines
      set last_run_at = now(),
        last_error = ${result.error ?? null},
        next_run_at = ${result.nextRunAt},
        updated_at = now()
      where id = ${id}
    `;
  }
}
