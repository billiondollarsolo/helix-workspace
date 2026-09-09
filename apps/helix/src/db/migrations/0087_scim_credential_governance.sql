-- SCIM credentials are independently staged and revoked. Tokens remain
-- one-way hashes; the embedded credential UUID selects exactly one Argon2
-- hash so an invalid request cannot force verification of every tenant key.

insert into actors (id, org_id, type, display_name, scopes, metadata)
values (
  '00000000-0000-4000-8000-000000000016',
  '00000000-0000-0000-0000-000000000000',
  'system'::actor_type,
  'SCIM Security Principal',
  '{}'::text[],
  '{"purpose":"scim_security_audit"}'::jsonb
)
on conflict (id) do nothing;

alter table tenant_scim_credentials
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists name text,
  add column if not exists scopes text[] not null default array[
    'scim.users.read', 'scim.users.write', 'scim.groups.read', 'scim.groups.write'
  ]::text[],
  add column if not exists source_cidrs inet[] not null default '{}',
  add column if not exists expires_at timestamptz not null default (now() + interval '90 days'),
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by_actor_id uuid,
  add column if not exists last_used_at timestamptz,
  add column if not exists last_used_ip inet,
  add column if not exists created_by_actor_id uuid;

insert into actors (org_id, type, display_name, scopes, metadata)
select distinct
  credential.org_id,
  'system'::actor_type,
  'SCIM Credential Migration',
  '{}'::text[],
  '{"purpose":"scim_credential_migration"}'::jsonb
from tenant_scim_credentials credential
where credential.created_by_actor_id is null
  and not exists (
    select 1 from actors actor
    where actor.org_id = credential.org_id
      and actor.metadata->>'purpose' = 'scim_credential_migration'
  );

update tenant_scim_credentials credential
set name = coalesce(credential.name, 'Initial SCIM credential'),
    token_hint = coalesce(credential.token_hint, '…legacy'),
    created_by_actor_id = coalesce(
      credential.created_by_actor_id,
      (
        select actor.id from actors actor
        where actor.id = credential.rotated_by_actor_id
          and actor.org_id = credential.org_id
      ),
      (
        select actor.id from actors actor
        where actor.org_id = credential.org_id
          and actor.metadata->>'purpose' = 'scim_credential_migration'
        order by actor.id
        limit 1
      )
    );

alter table tenant_scim_credentials
  alter column id set not null,
  alter column id drop default,
  alter column name set not null,
  alter column token_hint set not null,
  alter column created_by_actor_id set not null,
  drop constraint if exists tenant_scim_credentials_pkey,
  drop column if exists rotated_at,
  drop column if exists rotated_by_actor_id,
  add constraint tenant_scim_credentials_pkey primary key (id),
  add constraint tenant_scim_credentials_name_length
    check (char_length(btrim(name)) between 1 and 120),
  add constraint tenant_scim_credentials_token_hint_length
    check (char_length(token_hint) between 1 and 32),
  add constraint tenant_scim_credentials_scopes_valid
    check (
      cardinality(scopes) between 1 and 4
      and scopes <@ array[
        'scim.users.read', 'scim.users.write', 'scim.groups.read', 'scim.groups.write'
      ]::text[]
    ),
  add constraint tenant_scim_credentials_source_cidrs_limit
    check (cardinality(source_cidrs) <= 50),
  add constraint tenant_scim_credentials_expiry_after_creation
    check (expires_at > created_at and expires_at <= created_at + interval '366 days'),
  add constraint tenant_scim_credentials_created_by_org_fk
    foreign key (org_id, created_by_actor_id) references actors (org_id, id),
  add constraint tenant_scim_credentials_revoked_by_org_fk
    foreign key (org_id, revoked_by_actor_id) references actors (org_id, id);

drop index if exists tenant_scim_credentials_rotated_idx;
create unique index tenant_scim_credentials_org_name_idx
  on tenant_scim_credentials (org_id, lower(name));
create index tenant_scim_credentials_org_active_idx
  on tenant_scim_credentials (org_id, expires_at)
  where revoked_at is null;

alter table tenant_scim_credentials enable row level security;
drop policy if exists helix_tenant_isolation on tenant_scim_credentials;
create policy helix_tenant_isolation on tenant_scim_credentials
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
