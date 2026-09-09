-- OAuth 2.1 consent nonces, durable grants, refresh-token families, and
-- client revocation epochs. Greenfield schema: no legacy token migration path.

alter table agent_credentials
  add column if not exists revocation_epoch bigint not null default 0;
alter table agent_credentials
  add constraint agent_credentials_revocation_epoch_check check (revocation_epoch >= 0);

-- A client identifier is never recycled: otherwise an old epoch-0 token could
-- become valid again for a newly created credential with the same id.
drop index if exists agent_credentials_client_active_idx;
create unique index agent_credentials_oauth_client_id_uidx
  on agent_credentials (client_id)
  where credential_type = 'oauth_client';

alter table oauth_access_tokens
  add column if not exists client_epoch bigint not null default 0,
  add column if not exists refresh_family_id uuid;
alter table oauth_access_tokens
  add constraint oauth_access_tokens_client_epoch_check check (client_epoch >= 0);

create table if not exists oauth_consent_nonces (
  nonce_hash text primary key,
  client_id text not null,
  actor_id uuid not null,
  org_id uuid not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint oauth_consent_nonces_actor_fk
    foreign key (org_id, actor_id) references actors(org_id, id) on delete cascade,
  constraint oauth_consent_nonces_expiry_check check (expires_at > created_at)
);

create index if not exists oauth_consent_nonces_expiry_idx
  on oauth_consent_nonces (expires_at);

create table if not exists oauth_grants (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  actor_id uuid not null,
  org_id uuid not null,
  scopes text[] not null default '{}',
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint oauth_grants_actor_fk
    foreign key (org_id, actor_id) references actors(org_id, id) on delete cascade,
  unique (org_id, actor_id, client_id)
);

create index if not exists oauth_grants_client_idx
  on oauth_grants (org_id, client_id) where revoked_at is null;

create table if not exists oauth_refresh_tokens (
  token_hash text primary key,
  family_id uuid not null,
  client_id text not null,
  actor_id uuid not null,
  org_id uuid not null,
  scopes text[] not null default '{}',
  client_epoch bigint not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  replaced_by_hash text,
  created_at timestamptz not null default now(),
  constraint oauth_refresh_tokens_actor_fk
    foreign key (org_id, actor_id) references actors(org_id, id) on delete cascade,
  constraint oauth_refresh_tokens_client_epoch_check check (client_epoch >= 0),
  constraint oauth_refresh_tokens_expiry_check check (expires_at > issued_at)
);

create index if not exists oauth_refresh_tokens_family_idx
  on oauth_refresh_tokens (client_id, family_id);
create index if not exists oauth_refresh_tokens_expiry_idx
  on oauth_refresh_tokens (expires_at);
create index if not exists oauth_access_tokens_family_idx
  on oauth_access_tokens (client_id, refresh_family_id)
  where refresh_family_id is not null;

create unique index if not exists admin_oauth_apps_org_client_idx
  on admin_oauth_apps (org_id, client_id)
  where client_id is not null;
