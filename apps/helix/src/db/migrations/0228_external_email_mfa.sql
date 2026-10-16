-- Global sign-in factors belong to the Better Auth identity, like passkeys.
create table auth_external_email_factors (
  auth_user_id text primary key references "user"(id) on delete cascade,
  email text,
  verified_at timestamptz,
  enabled boolean not null default false,
  pending_email text,
  pending_code_digest text,
  pending_expires_at timestamptz,
  pending_attempts integer not null default 0 check (pending_attempts between 0 and 5),
  last_sent_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint external_email_verified check ((email is null) = (verified_at is null)),
  constraint external_email_factor_verified check (not enabled or verified_at is not null),
  constraint external_email_challenge_digest check (
    pending_code_digest is null or pending_code_digest ~ '^[0-9a-f]{64}$'
  )
);

create function helix_is_hosted_mail_domain(hostname text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public set row_security = off as $$
  select exists (select 1 from public.admin_domains
    where domain = lower(btrim(hostname)) and status = 'verified' and mail_enabled)
$$;
alter function helix_is_hosted_mail_domain(text) owner to helix_migration_owner;
revoke all on function helix_is_hosted_mail_domain(text) from public;
grant execute on function helix_is_hosted_mail_domain(text) to helix_app;
