-- Agent secrets: passwords, tokens and keys an administrator stores for the
-- organization's agents and service accounts, managed from Admin → Agent
-- secrets.
--
-- A secret is granted to named agents; nothing is available to an agent
-- without a grant. Each secret has one of two modes:
--   use_only  Helix adds it to requests it makes for the agent, to the listed
--             hosts only. No one, agent or administrator, can read it back.
--   handover  An agent with a grant may also be handed the value.
-- The value is sealed with the tenant envelope (purpose 'agent-secret').
--
-- secrets.use is the permission an agent's credential needs to reach the
-- secret tools at all. It gives access to nothing on its own.

insert into iam_permission_catalog (permission, catalog_version) values
  ('secrets.use', 2)
on conflict (permission) do nothing;

create table agent_secrets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  -- The handle agents ask for, for example 'github-deploy-token'.
  name text not null check (name ~ '^[a-z][a-z0-9._-]{0,62}$'),
  description text not null default '' check (char_length(description) <= 500),
  mode text not null check (mode in ('use_only', 'handover')),
  -- Hosts Helix may send the secret to. Empty means it is never sent anywhere.
  allowed_hosts text[] not null default '{}' check (cardinality(allowed_hosts) <= 20),
  -- How it is sent: `<header_name>: <header_prefix><value>`.
  header_name text not null default 'authorization' check (header_name ~ '^[a-z][a-z0-9-]{0,63}$'),
  header_prefix text not null default 'Bearer ' check (
    char_length(header_prefix) <= 32 and header_prefix !~ '[\r\n]'
  ),
  -- TenantEnvelopeCipher output for purpose 'agent-secret'.
  value_ciphertext text not null check (
    value_ciphertext ~ '^helix[$]1([$][A-Za-z0-9_-]+){6}$'
  ),
  -- Counts values: 1 when created, one more each time the value is replaced.
  version integer not null default 1 check (version >= 1),
  created_by_actor_id uuid,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  rotated_at timestamptz not null default statement_timestamp(),
  constraint agent_secrets_org_name_key unique (org_id, name),
  constraint agent_secrets_org_id_key unique (org_id, id),
  constraint agent_secrets_use_only_has_host
    check (mode <> 'use_only' or cardinality(allowed_hosts) >= 1),
  constraint agent_secrets_created_by_fk
    foreign key (org_id, created_by_actor_id)
    references actors (org_id, id) on delete set null (created_by_actor_id)
);

create table agent_secret_grants (
  org_id uuid not null,
  secret_id uuid not null,
  -- An agent or service account; the store refuses people.
  actor_id uuid not null,
  granted_by_actor_id uuid,
  granted_at timestamptz not null default statement_timestamp(),
  last_used_at timestamptz,
  use_count bigint not null default 0 check (use_count >= 0),
  primary key (secret_id, actor_id),
  constraint agent_secret_grants_secret_fk
    foreign key (org_id, secret_id) references agent_secrets (org_id, id) on delete cascade,
  constraint agent_secret_grants_actor_fk
    foreign key (org_id, actor_id) references actors (org_id, id) on delete cascade,
  constraint agent_secret_grants_granted_by_fk
    foreign key (org_id, granted_by_actor_id)
    references actors (org_id, id) on delete set null (granted_by_actor_id)
);

create index agent_secret_grants_actor_idx on agent_secret_grants (org_id, actor_id);

alter table agent_secrets enable row level security;
alter table agent_secrets force row level security;
create policy helix_tenant_isolation on agent_secrets
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
create policy helix_tenant_boundary on agent_secrets as restrictive for all
  using (org_id = public.helix_current_org_id())
  with check (org_id = public.helix_current_org_id());

alter table agent_secret_grants enable row level security;
alter table agent_secret_grants force row level security;
create policy helix_tenant_isolation on agent_secret_grants
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
create policy helix_tenant_boundary on agent_secret_grants as restrictive for all
  using (org_id = public.helix_current_org_id())
  with check (org_id = public.helix_current_org_id());
