alter table agent_credentials
  rename column agent_actor_id to actor_id;

alter table agent_credentials
  rename column client_secret_hash to secret_hash;

alter table agent_credentials
  add column if not exists credential_type text,
  add column if not exists cert_fingerprint text,
  add column if not exists rate_limit_overrides jsonb not null default '{}',
  add column if not exists ip_allowlist cidr[],
  add column if not exists allowed_hours jsonb,
  add column if not exists confirmation_override jsonb,
  add column if not exists created_by uuid references actors(id),
  add column if not exists last_used_at timestamptz,
  add column if not exists metadata jsonb not null default '{}';

update agent_credentials
set credential_type = 'oauth_client'
where credential_type is null;

alter table agent_credentials
  alter column credential_type set not null,
  alter column credential_type set default 'oauth_client',
  alter column secret_hash drop not null;

drop index if exists agent_credentials_client_idx;
create unique index if not exists agent_credentials_client_active_idx
  on agent_credentials (client_id)
  where revoked_at is null;

drop index if exists agent_credentials_actor_idx;
create index if not exists agent_credentials_actor_idx on agent_credentials (actor_id);

create table if not exists oauth_access_tokens (
  token_hash text primary key,
  client_id text not null,
  actor_id uuid not null references actors(id),
  org_id uuid not null,
  scopes text[] not null default '{}',
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists oauth_access_tokens_client_idx on oauth_access_tokens (client_id);
create index if not exists oauth_access_tokens_actor_idx on oauth_access_tokens (actor_id);
create index if not exists oauth_access_tokens_expires_at_idx on oauth_access_tokens (expires_at);
