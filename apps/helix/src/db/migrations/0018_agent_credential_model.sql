-- P1-5 / P1-7: Authorization Code OAuth flow + expanded agent credential model.
--
-- P1-7 expands agent_credentials from an OAuth-client-only table into a
-- multi-type credential store (PRD §9.2). Migration 0001 already added several
-- of the policy columns; the statements below are idempotent so this migration
-- is safe whether or not 0001 ran. It additionally:
--   * widens credential_type to a checked enum of oauth_client / api_key / mtls_cert
--   * adds api_key_hash for api_key credentials
--   * adds a label for operator-facing identification
--   * enforces a uniqueness constraint on cert_fingerprint per active credential
--
-- P1-5 adds oauth_authorization_codes: short-lived, single-use authorization
-- codes for the OAuth 2.1 Authorization Code + PKCE flow (PRD §13.6).

-- --- P1-7: expanded agent credential model -------------------------------

alter table agent_credentials
  add column if not exists credential_type text,
  add column if not exists cert_fingerprint text,
  add column if not exists api_key_hash text,
  add column if not exists label text,
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
  alter column credential_type set default 'oauth_client';

-- client_id / secret_hash are only meaningful for oauth_client credentials.
alter table agent_credentials
  alter column secret_hash drop not null;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'agent_credentials' and column_name = 'client_id'
      and is_nullable = 'NO'
  ) then
    alter table agent_credentials alter column client_id drop not null;
  end if;
end $$;

-- Constrain credential_type to the supported set (PRD §9.2).
alter table agent_credentials
  drop constraint if exists agent_credentials_credential_type_check;
alter table agent_credentials
  add constraint agent_credentials_credential_type_check
  check (credential_type in ('oauth_client', 'api_key', 'mtls_cert'));

-- Every credential type must carry the material it is identified by.
alter table agent_credentials
  drop constraint if exists agent_credentials_material_check;
alter table agent_credentials
  add constraint agent_credentials_material_check
  check (
    (credential_type = 'oauth_client' and client_id is not null and secret_hash is not null)
    or (credential_type = 'api_key' and api_key_hash is not null)
    or (credential_type = 'mtls_cert' and cert_fingerprint is not null)
  );

drop index if exists agent_credentials_client_idx;
create unique index if not exists agent_credentials_client_active_idx
  on agent_credentials (client_id)
  where revoked_at is null and client_id is not null;

create unique index if not exists agent_credentials_api_key_active_idx
  on agent_credentials (api_key_hash)
  where revoked_at is null and api_key_hash is not null;

create unique index if not exists agent_credentials_cert_active_idx
  on agent_credentials (cert_fingerprint)
  where revoked_at is null and cert_fingerprint is not null;

drop index if exists agent_credentials_actor_idx;
create index if not exists agent_credentials_actor_idx on agent_credentials (actor_id);
create index if not exists agent_credentials_type_idx on agent_credentials (credential_type);

-- --- P1-7: oauth_access_tokens (idempotent; also created by 0001) ----------

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

-- --- P1-5: authorization codes --------------------------------------------

create table if not exists oauth_authorization_codes (
  code_hash text primary key,
  client_id text not null,
  actor_id uuid not null references actors(id),
  org_id uuid not null,
  redirect_uri text not null,
  scopes text[] not null default '{}',
  code_challenge text not null,
  code_challenge_method text not null
    check (code_challenge_method in ('S256', 'plain')),
  state text,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists oauth_authorization_codes_client_idx
  on oauth_authorization_codes (client_id);
create index if not exists oauth_authorization_codes_expires_at_idx
  on oauth_authorization_codes (expires_at);
