import type postgres from "postgres";
import type { JsonObject, MeteringEventPayload } from "@helix/sdk-types";

export interface StoredMeteringEvent {
  readonly id: string;
  readonly orgId: string;
  readonly eventType: string;
  readonly quantity: string;
  readonly metadata: JsonObject;
  readonly occurredAt: string;
  readonly rolledUpAt?: string;
}

export interface MeteringEventInsert {
  readonly orgId: string;
  readonly eventType: string;
  readonly quantity: string;
  readonly metadata: JsonObject;
  readonly occurredAt?: Date;
}

export interface MeteringEventStore {
  insertEvent(event: MeteringEventInsert): Promise<StoredMeteringEvent>;
  insertEvents(events: readonly MeteringEventInsert[]): Promise<readonly StoredMeteringEvent[]>;
}

export interface MeteringRollupRunInput {
  readonly cutoff: Date;
  readonly periodLimit: number;
}

export interface MeteringRollupRunResult {
  readonly periodCount: number;
  readonly rollupCount: number;
  readonly eventCount: number;
}

export interface MeteringRollupStore {
  rollupCompletedPeriods(input: MeteringRollupRunInput): Promise<MeteringRollupRunResult>;
}

interface MeteringEventRow {
  readonly id: string;
  readonly org_id: string;
  readonly event_type: string;
  readonly quantity: string;
  readonly metadata: JsonObject;
  readonly occurred_at: Date;
  readonly rolled_up_at: Date | null;
}

export class PostgresMeteringEventStore implements MeteringEventStore {
  constructor(private readonly sql: postgres.Sql) {}

  async insertEvent(event: MeteringEventInsert): Promise<StoredMeteringEvent> {
    const rows = await this.sql`
      insert into metering_events (org_id, event_type, quantity, metadata, occurred_at)
      values (
        ${event.orgId},
        ${event.eventType},
        ${event.quantity},
        ${this.sql.json(event.metadata)},
        ${event.occurredAt ?? new Date()}
      )
      returning id, org_id, event_type, quantity::text as quantity, metadata, occurred_at, rolled_up_at
    `;
    return toStoredMeteringEvent((rows as unknown as readonly MeteringEventRow[])[0]);
  }

  async insertEvents(
    events: readonly MeteringEventInsert[],
  ): Promise<readonly StoredMeteringEvent[]> {
    const inserted: StoredMeteringEvent[] = [];
    for (const event of events) {
      inserted.push(await this.insertEvent(event));
    }
    return inserted;
  }
}

export class PostgresMeteringRollupStore implements MeteringRollupStore {
  constructor(private readonly sql: postgres.Sql) {}

  async rollupCompletedPeriods(input: MeteringRollupRunInput): Promise<MeteringRollupRunResult> {
    const rows = await this.sql`
      with candidate_periods as (
        select distinct
          org_id,
          date_trunc('day', occurred_at)::date as period_start
        from metering_events
        where rolled_up_at is null
          and occurred_at < ${input.cutoff}
        order by org_id, period_start
        limit ${input.periodLimit}
      ),
      aggregated as (
        select
          events.org_id,
          candidate.period_start,
          (candidate.period_start + 1)::date as period_end,
          case events.event_type
            when 'ai.tokens' then 'ai_tokens'
            when 'ai.image.generated' then 'ai_images_generated'
            when 'storage.delta' then 'storage_delta_bytes'
            when 'seats.delta' then 'seats_delta'
            when 'export.completed' then 'exports_count'
            when 'collab.session.opened' then 'collab_session_seconds'
            when 'api.call.billable' then 'api_calls_billable'
          end as metric_key,
          sum(events.quantity) as quantity,
          jsonb_build_object(
            'event_count',
            count(*),
            'rollup_kind',
            'sum',
            'source',
            'metering_events_v1'
          ) as details
        from metering_events events
        join candidate_periods candidate
          on candidate.org_id = events.org_id
          and events.occurred_at >= candidate.period_start
          and events.occurred_at < candidate.period_start + interval '1 day'
        where events.event_type in (
          'ai.tokens',
          'ai.image.generated',
          'storage.delta',
          'seats.delta',
          'export.completed',
          'collab.session.opened',
          'api.call.billable'
        )
        group by events.org_id, candidate.period_start, metric_key
      ),
      storage_baselines as (
        select
          candidate.org_id,
          candidate.period_start,
          coalesce(sum(prior.quantity), 0) as baseline
        from candidate_periods candidate
        left join metering_events prior
          on prior.org_id = candidate.org_id
          and prior.event_type = 'storage.delta'
          and prior.occurred_at < candidate.period_start
        group by candidate.org_id, candidate.period_start
      ),
      storage_points as (
        select
          baseline.org_id,
          baseline.period_start,
          baseline.period_start as sample_at,
          baseline.baseline as quantity
        from storage_baselines baseline
        union all
        select
          candidate.org_id,
          candidate.period_start,
          events.occurred_at as sample_at,
          baseline.baseline + coalesce(
            sum(events.quantity) over (
              partition by candidate.org_id, candidate.period_start
              order by events.occurred_at, events.id
              rows between unbounded preceding and current row
            ),
            0
          ) as quantity
        from candidate_periods candidate
        join storage_baselines baseline
          on baseline.org_id = candidate.org_id
          and baseline.period_start = candidate.period_start
        join metering_events events
          on events.org_id = candidate.org_id
          and events.event_type = 'storage.delta'
          and events.occurred_at >= candidate.period_start
          and events.occurred_at < candidate.period_start + interval '1 day'
      ),
      storage_daily as (
        select
          org_id,
          period_start,
          (period_start + 1)::date as period_end,
          'storage_avg_bytes' as metric_key,
          greatest(avg(quantity), 0) as quantity,
          jsonb_build_object(
            'event_count',
            count(*) - 1,
            'rollup_kind',
            'daily_average_from_deltas',
            'source',
            'metering_events_v1'
          ) as details
        from storage_points
        group by org_id, period_start
      ),
      seat_baselines as (
        select
          candidate.org_id,
          candidate.period_start,
          coalesce(sum(prior.quantity), 0) as baseline
        from candidate_periods candidate
        left join metering_events prior
          on prior.org_id = candidate.org_id
          and prior.event_type = 'seats.delta'
          and prior.occurred_at < candidate.period_start
        group by candidate.org_id, candidate.period_start
      ),
      seat_points as (
        select
          baseline.org_id,
          baseline.period_start,
          baseline.period_start as sample_at,
          baseline.baseline as quantity
        from seat_baselines baseline
        union all
        select
          candidate.org_id,
          candidate.period_start,
          events.occurred_at as sample_at,
          baseline.baseline + coalesce(
            sum(events.quantity) over (
              partition by candidate.org_id, candidate.period_start
              order by events.occurred_at, events.id
              rows between unbounded preceding and current row
            ),
            0
          ) as quantity
        from candidate_periods candidate
        join seat_baselines baseline
          on baseline.org_id = candidate.org_id
          and baseline.period_start = candidate.period_start
        join metering_events events
          on events.org_id = candidate.org_id
          and events.event_type = 'seats.delta'
          and events.occurred_at >= candidate.period_start
          and events.occurred_at < candidate.period_start + interval '1 day'
      ),
      seats_daily as (
        select
          org_id,
          period_start,
          (period_start + 1)::date as period_end,
          'seats_max' as metric_key,
          greatest(max(quantity), 0) as quantity,
          jsonb_build_object(
            'event_count',
            count(*) - 1,
            'rollup_kind',
            'daily_max_from_deltas',
            'source',
            'metering_events_v1'
          ) as details
        from seat_points
        group by org_id, period_start
      ),
      rollups as (
        select * from aggregated
        union all select * from storage_daily
        union all select * from seats_daily
      ),
      upserted as (
        insert into metering_rollups (
          org_id,
          period_start,
          period_end,
          metric_key,
          quantity,
          details,
          computed_at
        )
        select
          org_id,
          period_start,
          period_end,
          metric_key,
          quantity,
          details,
          now()
        from rollups
        where metric_key is not null
        on conflict (org_id, period_start, metric_key)
        do update set
          period_end = excluded.period_end,
          quantity = excluded.quantity,
          details = excluded.details,
          computed_at = excluded.computed_at
        returning org_id, period_start, metric_key
      ),
      marked as (
        update metering_events events
        set rolled_up_at = now()
        from candidate_periods candidate
        where events.rolled_up_at is null
          and events.org_id = candidate.org_id
          and events.occurred_at >= candidate.period_start
          and events.occurred_at < candidate.period_start + interval '1 day'
        returning events.id
      )
      select
        (select count(*)::int from candidate_periods) as period_count,
        (select count(*)::int from upserted) as rollup_count,
        (select count(*)::int from marked) as event_count
    `;
    const row = (rows as unknown as readonly MeteringRollupRunRow[])[0];
    return {
      periodCount: row?.period_count ?? 0,
      rollupCount: row?.rollup_count ?? 0,
      eventCount: row?.event_count ?? 0,
    };
  }
}

export function meteringEventInsertFromPayload(
  payload: MeteringEventPayload,
  fallbackOccurredAt: string,
): MeteringEventInsert {
  return {
    orgId: payload.orgId,
    eventType: payload.eventType,
    quantity: payload.quantity,
    metadata: payload.metadata,
    occurredAt: new Date(payload.occurredAt ?? fallbackOccurredAt),
  };
}

function toStoredMeteringEvent(row: MeteringEventRow | undefined): StoredMeteringEvent {
  if (row === undefined) {
    throw new Error("Metering event insert did not return a row.");
  }

  return {
    id: row.id,
    orgId: row.org_id,
    eventType: row.event_type,
    quantity: row.quantity,
    metadata: row.metadata,
    occurredAt: row.occurred_at.toISOString(),
    ...(row.rolled_up_at === null ? {} : { rolledUpAt: row.rolled_up_at.toISOString() }),
  };
}

interface MeteringRollupRunRow {
  readonly period_count: number;
  readonly rollup_count: number;
  readonly event_count: number;
}
