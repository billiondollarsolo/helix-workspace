import type postgres from "postgres";

/**
 * A per-user AI cost limit override. `null` fields fall back to the tier
 * default for that dimension (see `tierAICostBudgets`).
 */
export interface AICostLimitOverride {
  readonly orgId: string;
  readonly actorId: string;
  readonly actorDailyUsdMicros: number | null;
  readonly featureDailyUsdMicros: number | null;
  readonly updatedByActorId: string | null;
  readonly updatedAt: string;
}

export interface AICostLimitUpsertInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly actorDailyUsdMicros: number | null;
  readonly featureDailyUsdMicros: number | null;
  readonly updatedByActorId?: string | undefined;
}

/**
 * Durable store of per-user AI cost limit overrides. Backed by the
 * `ai_cost_limits` table; the admin API reads and writes through this store.
 */
export interface AICostLimitStore {
  get(input: { readonly orgId: string; readonly actorId: string }): Promise<AICostLimitOverride | null>;
  list(input: { readonly orgId: string }): Promise<readonly AICostLimitOverride[]>;
  upsert(input: AICostLimitUpsertInput): Promise<AICostLimitOverride>;
  remove(input: { readonly orgId: string; readonly actorId: string }): Promise<boolean>;
}

interface AICostLimitRow {
  readonly org_id: string;
  readonly actor_id: string;
  readonly actor_daily_usd_micros: string | number | null;
  readonly feature_daily_usd_micros: string | number | null;
  readonly updated_by_actor_id: string | null;
  readonly updated_at: Date;
}

export class PostgresAICostLimitStore implements AICostLimitStore {
  constructor(private readonly sql: postgres.Sql) {}

  async get(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<AICostLimitOverride | null> {
    const rows = (await this.sql`
      select org_id, actor_id, actor_daily_usd_micros, feature_daily_usd_micros,
             updated_by_actor_id, updated_at
      from ai_cost_limits
      where org_id = ${input.orgId} and actor_id = ${input.actorId}
      limit 1
    `) as readonly AICostLimitRow[];
    const row = rows[0];
    return row === undefined ? null : toOverride(row);
  }

  async list(input: { readonly orgId: string }): Promise<readonly AICostLimitOverride[]> {
    const rows = (await this.sql`
      select org_id, actor_id, actor_daily_usd_micros, feature_daily_usd_micros,
             updated_by_actor_id, updated_at
      from ai_cost_limits
      where org_id = ${input.orgId}
      order by updated_at desc
    `) as readonly AICostLimitRow[];
    return rows.map(toOverride);
  }

  async upsert(input: AICostLimitUpsertInput): Promise<AICostLimitOverride> {
    const rows = (await this.sql`
      insert into ai_cost_limits (
        org_id, actor_id, actor_daily_usd_micros, feature_daily_usd_micros,
        updated_by_actor_id, updated_at
      )
      values (
        ${input.orgId},
        ${input.actorId},
        ${input.actorDailyUsdMicros},
        ${input.featureDailyUsdMicros},
        ${input.updatedByActorId ?? null},
        now()
      )
      on conflict (org_id, actor_id)
      do update set
        actor_daily_usd_micros = excluded.actor_daily_usd_micros,
        feature_daily_usd_micros = excluded.feature_daily_usd_micros,
        updated_by_actor_id = excluded.updated_by_actor_id,
        updated_at = now()
      returning org_id, actor_id, actor_daily_usd_micros, feature_daily_usd_micros,
                updated_by_actor_id, updated_at
    `) as readonly AICostLimitRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error("AI cost limit upsert returned no row");
    }
    return toOverride(row);
  }

  async remove(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<boolean> {
    const rows = (await this.sql`
      delete from ai_cost_limits
      where org_id = ${input.orgId} and actor_id = ${input.actorId}
      returning actor_id
    `) as readonly { readonly actor_id: string }[];
    return rows.length > 0;
  }
}

/**
 * In-memory {@link AICostLimitStore}, used as a fallback when Postgres is not
 * configured (mirrors the in-memory fallbacks elsewhere in the platform).
 */
export class InMemoryAICostLimitStore implements AICostLimitStore {
  readonly #records = new Map<string, AICostLimitOverride>();

  async get(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<AICostLimitOverride | null> {
    return this.#records.get(key(input.orgId, input.actorId)) ?? null;
  }

  async list(input: { readonly orgId: string }): Promise<readonly AICostLimitOverride[]> {
    return [...this.#records.values()]
      .filter((record) => record.orgId === input.orgId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async upsert(input: AICostLimitUpsertInput): Promise<AICostLimitOverride> {
    const record: AICostLimitOverride = {
      orgId: input.orgId,
      actorId: input.actorId,
      actorDailyUsdMicros: input.actorDailyUsdMicros,
      featureDailyUsdMicros: input.featureDailyUsdMicros,
      updatedByActorId: input.updatedByActorId ?? null,
      updatedAt: new Date().toISOString(),
    };
    this.#records.set(key(input.orgId, input.actorId), record);
    return record;
  }

  async remove(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<boolean> {
    return this.#records.delete(key(input.orgId, input.actorId));
  }
}

function toOverride(row: AICostLimitRow): AICostLimitOverride {
  return {
    orgId: row.org_id,
    actorId: row.actor_id,
    actorDailyUsdMicros: toNullableNumber(row.actor_daily_usd_micros),
    featureDailyUsdMicros: toNullableNumber(row.feature_daily_usd_micros),
    updatedByActorId: row.updated_by_actor_id,
    updatedAt: row.updated_at.toISOString(),
  };
}

function toNullableNumber(value: string | number | null): number | null {
  if (value === null) {
    return null;
  }
  return typeof value === "number" ? value : Number(value);
}

function key(orgId: string, actorId: string): string {
  return `${orgId}:${actorId}`;
}
