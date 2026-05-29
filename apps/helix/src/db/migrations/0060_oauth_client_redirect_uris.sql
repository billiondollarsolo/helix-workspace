-- CRITICAL-3 (REVIEW.md): /oauth/authorize must reject any redirect_uri not on
-- a per-client allowlist. Adds a `redirect_uris text[]` column to
-- `agent_credentials` and backfills existing oauth_client rows to an empty
-- array. Empty array means "no redirect URIs registered" — the authorize
-- endpoint MUST refuse to issue a code for such a client until an admin
-- registers one, which is the intended deny-by-default behaviour.

alter table agent_credentials
  add column if not exists redirect_uris text[] not null default '{}';

-- No-op when the column already existed with data; keeps the default '{}'
-- semantics for previously created oauth_client rows.
update agent_credentials
set redirect_uris = '{}'
where credential_type = 'oauth_client'
  and redirect_uris is null;
