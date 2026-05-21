-- P0-6: Persist resource classification tags.
--
-- Resource classifications were previously held only in
-- InMemoryResourceClassificationStore and were lost on restart and never
-- shared across replicas. This table makes classification durable. The
-- PostgresResourceClassificationStore upserts one row per
-- (org, resource_type, resource_id) tuple.

create table if not exists resource_classifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  resource_type text not null,
  resource_id text not null,
  classification text not null
    check (classification in ('public', 'standard', 'confidential', 'restricted')),
  source text not null
    check (source in ('default', 'explicit', 'label', 'folder', 'heuristic')),
  reason text not null,
  actor_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists resource_classifications_resource_idx
  on resource_classifications (org_id, resource_type, resource_id);

create index if not exists resource_classifications_org_classification_idx
  on resource_classifications (org_id, classification);

create index if not exists resource_classifications_updated_idx
  on resource_classifications (org_id, updated_at desc);

-- P0-7: durable per-user AI cost limit overrides.
--
-- Tier defaults (tierAICostBudgets) still apply when no override exists; this
-- table lets admins raise or lower an individual user's daily AI budget. The
-- web admin UI reads and writes these rows through the admin API.

create table if not exists ai_cost_limits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  actor_id uuid not null,
  -- null => fall back to the tier default for this dimension.
  actor_daily_usd_micros bigint
    check (actor_daily_usd_micros is null or actor_daily_usd_micros >= 0),
  feature_daily_usd_micros bigint
    check (feature_daily_usd_micros is null or feature_daily_usd_micros >= 0),
  updated_by_actor_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ai_cost_limits_actor_idx
  on ai_cost_limits (org_id, actor_id);
