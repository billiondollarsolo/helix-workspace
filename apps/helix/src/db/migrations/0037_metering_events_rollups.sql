create table if not exists metering_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  event_type text not null,
  quantity numeric not null,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  rolled_up_at timestamptz
);

create index if not exists metering_events_org_time_idx
  on metering_events (org_id, occurred_at);

create index if not exists metering_events_unrolled_idx
  on metering_events (occurred_at)
  where rolled_up_at is null;

create table if not exists metering_rollups (
  org_id uuid not null references orgs(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  metric_key text not null,
  quantity numeric not null,
  details jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  primary key (org_id, period_start, metric_key)
);

create index if not exists metering_rollups_org_metric_idx
  on metering_rollups (org_id, metric_key, period_start);

alter table metering_events enable row level security;
drop policy if exists helix_tenant_isolation on metering_events;
create policy helix_tenant_isolation on metering_events
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

alter table metering_rollups enable row level security;
drop policy if exists helix_tenant_isolation on metering_rollups;
create policy helix_tenant_isolation on metering_rollups
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
