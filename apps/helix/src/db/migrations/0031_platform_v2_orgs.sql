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
  updated_at timestamptz not null default now(),
  constraint orgs_byo_storage_secret_handle check (
    coalesce(byo_config->'storage'->>'kind', '') <> 'byo'
    or coalesce(
      byo_config->'storage'->>'credentials_secret_handle' ~ '^[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?$',
      false
    )
  ),
  constraint orgs_byo_config_no_credentials check (
    not jsonb_path_exists(
      byo_config,
      '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^((aws[-_]?)?access[-_]?key([-_]?id)?|(aws[-_]?)?secret[-_]?access[-_]?key|secret[-_]?key|password|pass|token|access[-_]?token|refresh[-_]?token|id[-_]?token|(aws[-_]?)?session[-_]?token|api[-_]?key|client[-_]?secret|private[-_]?key|signing[-_]?(key|secret)|credential(s)?)$" flag "i")'
    )
    and byo_config->'storage'->>'endpoint' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'
  )
);

create unique index if not exists orgs_slug_idx on orgs (slug);
create index if not exists orgs_status_idx on orgs (status);

insert into orgs (id, slug, display_name, status, region, metadata)
values (
  '00000000-0000-0000-0000-000000000000',
  'default',
  'Default Organization',
  'active',
  coalesce(nullif(current_setting('helix.deployment_region', true), ''), 'default'),
  '{"source":"platform-v2-migration"}'::jsonb
)
on conflict (id) do nothing;
