do $$ begin
  create type org_status as enum ('active', 'suspended', 'soft_deleted');
exception when duplicate_object then null; end $$;

create table if not exists orgs (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  display_name text not null,
  status org_status not null default 'active',
  tier text not null default 'personal',
  region text not null default 'default',
  byo_config jsonb not null default '{}',
  feature_flags jsonb not null default '{}',
  quotas jsonb not null default '{}',
  branding jsonb not null default '{}',
  metadata jsonb not null default '{}',
  soft_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists orgs_slug_idx on orgs (slug);
create index if not exists orgs_status_idx on orgs (status);

insert into orgs (id, slug, display_name, status, metadata)
values (
  '00000000-0000-0000-0000-000000000000',
  'default',
  'Default Organization',
  'active',
  '{"source":"platform-v2-migration"}'::jsonb
)
on conflict (id) do nothing;
