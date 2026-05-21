do $$ begin
  create type webhook_delivery_status as enum ('pending', 'in_progress', 'delivered', 'failed', 'abandoned');
exception when duplicate_object then null; end $$;

do $$ begin
  create type webhook_direction as enum ('outbound', 'inbound');
exception when duplicate_object then null; end $$;

create table if not exists outbound_webhooks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  name text not null,
  url text not null,
  event_subjects text[] not null default '{}',
  secret_ref text,
  headers jsonb not null default '{}',
  enabled boolean not null default true,
  metadata jsonb not null default '{}',
  created_by_actor_id uuid references actors(id),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists outbound_webhooks_org_enabled_idx on outbound_webhooks (org_id, enabled);
create index if not exists outbound_webhooks_org_name_idx on outbound_webhooks (org_id, name);

create table if not exists inbound_webhooks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  name text not null,
  source text not null,
  secret_ref text,
  enabled boolean not null default true,
  metadata jsonb not null default '{}',
  created_by_actor_id uuid references actors(id),
  disabled_at timestamptz,
  last_received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists inbound_webhooks_org_enabled_idx on inbound_webhooks (org_id, enabled);
create index if not exists inbound_webhooks_org_source_idx on inbound_webhooks (org_id, source);

create table if not exists webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  direction webhook_direction not null,
  outbound_webhook_id uuid references outbound_webhooks(id),
  inbound_webhook_id uuid references inbound_webhooks(id),
  event_subject text not null,
  status webhook_delivery_status not null default 'pending',
  attempt integer not null default 0,
  payload jsonb not null,
  payload_sha256 text,
  signature text,
  request_headers jsonb not null default '{}',
  response_status integer,
  response_headers jsonb not null default '{}',
  error text,
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists webhook_deliveries_org_status_idx on webhook_deliveries (org_id, status);
create index if not exists webhook_deliveries_outbound_idx on webhook_deliveries (outbound_webhook_id);
create index if not exists webhook_deliveries_inbound_idx on webhook_deliveries (inbound_webhook_id);
create index if not exists webhook_deliveries_next_attempt_idx on webhook_deliveries (next_attempt_at, status);
