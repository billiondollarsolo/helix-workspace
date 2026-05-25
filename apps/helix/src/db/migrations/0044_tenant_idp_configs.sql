create table if not exists tenant_idp_configs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  protocol text not null check (protocol in ('saml', 'oidc')),
  is_primary boolean not null default true,
  display_name text not null,
  config jsonb not null default '{}',
  signing_cert_vault_path text,
  attr_mapping jsonb not null default '{}',
  jit_provisioning boolean not null default true,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_idp_configs_config_object check (jsonb_typeof(config) = 'object'),
  constraint tenant_idp_configs_attr_mapping_object check (jsonb_typeof(attr_mapping) = 'object')
);

create unique index if not exists tenant_idp_configs_primary_idx
  on tenant_idp_configs (org_id)
  where is_primary and enabled;

create index if not exists tenant_idp_configs_org_idx
  on tenant_idp_configs (org_id, enabled, is_primary);
