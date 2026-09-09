-- Better Auth remains the single session/device inventory. This function adds
-- the tenant policy gate used by every session-authenticated request.

create function helix_session_policy_integer(
  input_settings jsonb,
  input_key text,
  input_default integer,
  input_minimum integer,
  input_maximum integer
)
returns integer
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case
    when jsonb_typeof(input_settings -> input_key) = 'number'
      and (input_settings ->> input_key) ~ '^[0-9]+$'
    then greatest(
      input_minimum::numeric,
      least(input_maximum::numeric, (input_settings ->> input_key)::numeric)
    )::integer
    else input_default
  end
$$;

create table auth_session_tenant_access (
  session_id text not null references "session"(id) on delete cascade,
  org_id uuid not null,
  actor_id uuid not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  revoked_at timestamptz,
  revocation_reason text,
  primary key (session_id, org_id),
  foreign key (org_id, actor_id) references actors(org_id, id) on delete cascade,
  constraint auth_session_tenant_access_revocation_complete check (
    (revoked_at is null and revocation_reason is null)
    or (revoked_at is not null and char_length(revocation_reason) > 0)
  )
);

create index auth_session_tenant_access_actor_idx
  on auth_session_tenant_access (org_id, actor_id, last_seen_at desc)
  where revoked_at is null;

alter table auth_session_tenant_access enable row level security;
alter table auth_session_tenant_access force row level security;
create policy helix_tenant_isolation on auth_session_tenant_access
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

create function helix_authorize_tenant_session(
  input_token text,
  input_user_id text,
  input_org_id uuid,
  input_actor_id uuid,
  input_admin_action boolean,
  input_now timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_session session%rowtype;
  tenant_access auth_session_tenant_access%rowtype;
  settings jsonb := '{}'::jsonb;
  absolute_days integer := 7;
  idle_days integer := 14;
  max_sessions integer := 10;
  reauth_minutes integer := 10;
  require_admin_reauth boolean := true;
begin
  -- Serialize policy checks for one identity so the concurrent cap cannot be
  -- raced by simultaneous first requests from newly-created sessions.
  perform pg_advisory_xact_lock(
    hashtextextended(input_org_id::text || ':' || input_actor_id::text, 913)
  );

  select s.* into current_session
  from "session" s
  where s.token = input_token
    and s."userId" = input_user_id
  for update;

  if not found
    or current_session."expiresAt" <= input_now
    or not exists (
      select 1
      from identity_provider_subjects provider
      join identity_subjects subject on subject.id = provider.subject_id
      join organization_memberships membership
        on membership.subject_id = subject.id
      join actors actor
        on actor.org_id = membership.org_id and actor.id = membership.actor_id
      join orgs organization on organization.id = membership.org_id
      where provider.provider = 'better-auth'
        and provider.provider_subject = input_user_id
        and membership.org_id = input_org_id
        and membership.actor_id = input_actor_id
        and subject.status = 'active'
        and membership.status = 'active'
        and actor.disabled_at is null
        and organization.status = 'active'
    )
  then
    return false;
  end if;

  insert into auth_session_tenant_access (
    session_id, org_id, actor_id, first_seen_at, last_seen_at
  ) values (
    current_session.id, input_org_id, input_actor_id,
    current_session."createdAt", current_session."createdAt"
  ) on conflict (session_id, org_id) do nothing;

  select access.* into tenant_access
  from auth_session_tenant_access access
  where access.session_id = current_session.id and access.org_id = input_org_id
  for update;

  if tenant_access.actor_id <> input_actor_id or tenant_access.revoked_at is not null then
    return false;
  end if;

  select policy.settings into settings
  from admin_security_policies policy
  where policy.org_id = input_org_id
    and policy.policy_type = 'session'
    and policy.enabled
    and policy.enforcement <> 'disabled';
  settings := coalesce(settings, '{}'::jsonb);

  absolute_days := helix_session_policy_integer(
    settings, 'absoluteLifetimeDays', 7, 1, 90
  );
  idle_days := helix_session_policy_integer(
    settings, 'inactivityTimeoutDays', 14, 1, 90
  );
  max_sessions := helix_session_policy_integer(
    settings, 'maxConcurrentSessions', 10, 1, 50
  );
  reauth_minutes := helix_session_policy_integer(
    settings, 'reauthIntervalMinutes', 10, 1, 1440
  );
  require_admin_reauth := case
    when jsonb_typeof(settings -> 'reauthForAdminActions') = 'boolean'
      then (settings ->> 'reauthForAdminActions')::boolean
    else true
  end;

  if tenant_access.first_seen_at + make_interval(days => absolute_days) <= input_now
    or tenant_access.last_seen_at + make_interval(days => idle_days) <= input_now
  then
    update auth_session_tenant_access
    set revoked_at = input_now,
        revocation_reason = case
          when tenant_access.first_seen_at + make_interval(days => absolute_days) <= input_now
            then 'absolute_timeout'
          else 'idle_timeout'
        end
    where session_id = current_session.id and org_id = input_org_id;
    return false;
  end if;

  if input_admin_action and require_admin_reauth
    and coalesce(current_session.mfa_verified_at, current_session."createdAt")
      + make_interval(mins => reauth_minutes) <= input_now
  then
    return false;
  end if;

  update "session"
  set "updatedAt" = input_now
  where id = current_session.id;

  update auth_session_tenant_access
  set last_seen_at = input_now
  where session_id = current_session.id and org_id = input_org_id;

  with excess as (
    select access.session_id
    from auth_session_tenant_access access
    join "session" s on s.id = access.session_id
    where access.org_id = input_org_id
      and access.actor_id = input_actor_id
      and access.revoked_at is null
      and s."expiresAt" > input_now
    order by access.last_seen_at desc, access.first_seen_at desc, access.session_id desc
    offset max_sessions
  )
  update auth_session_tenant_access access
  set revoked_at = input_now, revocation_reason = 'concurrent_limit'
  from excess
  where access.session_id = excess.session_id and access.org_id = input_org_id;

  return exists (
    select 1 from auth_session_tenant_access
    where session_id = current_session.id
      and org_id = input_org_id
      and revoked_at is null
  );
end
$$;

create function helix_revoke_identity_sessions()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  affected_subject_id uuid;
  affected_org_id uuid;
  affected_actor_id uuid;
  reason text;
begin
  if tg_table_name = 'account' then
    if old.password is distinct from new.password then
      delete from "session" where "userId" = new."userId";
    end if;
    return new;
  end if;

  if tg_table_name = 'organization_memberships' then
    if old.status is distinct from new.status
      or old.roles is distinct from new.roles
      or old.org_unit_id is distinct from new.org_unit_id
    then
      select subject_id into affected_subject_id
      from organization_memberships where id = new.id;
      affected_org_id := new.org_id;
      affected_actor_id := new.actor_id;
      reason := 'membership_changed';
    else
      return new;
    end if;
  elsif tg_table_name = 'actors' then
    if old.disabled_at is distinct from new.disabled_at
      or old.scopes is distinct from new.scopes
    then
      select subject_id into affected_subject_id
      from organization_memberships where org_id = new.org_id and actor_id = new.id;
      affected_org_id := new.org_id;
      affected_actor_id := new.id;
      reason := 'actor_authority_changed';
    else
      return new;
    end if;
  elsif tg_table_name = 'identity_subjects' then
    if old.status is distinct from new.status then
      delete from "session" s
      using identity_provider_subjects provider
      where provider.provider = 'better-auth'
        and provider.subject_id = new.id
        and s."userId" = provider.provider_subject;
      return new;
    else
      return new;
    end if;
  elsif tg_table_name = 'iam_role_bindings' then
    if tg_op = 'DELETE' then
      select subject_id into affected_subject_id
      from organization_memberships
      where org_id = old.org_id and id = old.membership_id;
      affected_org_id := old.org_id;
      select actor_id into affected_actor_id
      from organization_memberships
      where org_id = old.org_id and id = old.membership_id;
    elsif tg_op = 'INSERT' or old.revoked_at is distinct from new.revoked_at then
      select subject_id, actor_id into affected_subject_id, affected_actor_id
      from organization_memberships
      where org_id = new.org_id and id = new.membership_id;
      affected_org_id := new.org_id;
    else
      return new;
    end if;
    reason := 'role_binding_changed';
  end if;

  if affected_subject_id is not null
    and affected_org_id is not null
    and affected_actor_id is not null
  then
    insert into auth_session_tenant_access (
      session_id, org_id, actor_id, first_seen_at, last_seen_at,
      revoked_at, revocation_reason
    )
    select
      s.id, affected_org_id, affected_actor_id, s."createdAt", s."updatedAt", now(), reason
    from "session" s
    join identity_provider_subjects provider
      on provider.provider_subject = s."userId"
    where provider.provider = 'better-auth'
      and provider.subject_id = affected_subject_id
    on conflict (session_id, org_id) do update
      set revoked_at = excluded.revoked_at,
          revocation_reason = excluded.revocation_reason;
  end if;
  return coalesce(new, old);
end
$$;

create trigger better_auth_account_password_revoke_sessions
after update of password on account
for each row execute function helix_revoke_identity_sessions();
create trigger organization_memberships_authority_revoke_sessions
after update of status, roles, org_unit_id on organization_memberships
for each row execute function helix_revoke_identity_sessions();
create trigger actors_authority_revoke_sessions
after update of disabled_at, scopes on actors
for each row execute function helix_revoke_identity_sessions();
create trigger identity_subjects_status_revoke_sessions
after update of status on identity_subjects
for each row execute function helix_revoke_identity_sessions();
create trigger iam_role_bindings_authority_revoke_sessions
after insert or update of revoked_at or delete on iam_role_bindings
for each row execute function helix_revoke_identity_sessions();

create function helix_revoke_org_sessions()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.status is distinct from new.status then
    insert into auth_session_tenant_access (
      session_id, org_id, actor_id, first_seen_at, last_seen_at,
      revoked_at, revocation_reason
    )
    select
      s.id, membership.org_id, membership.actor_id,
      s."createdAt", s."updatedAt", now(), 'organization_status_changed'
    from organization_memberships membership
    join identity_provider_subjects provider on provider.subject_id = membership.subject_id
    join "session" s on s."userId" = provider.provider_subject
    where membership.org_id = new.id and provider.provider = 'better-auth'
    on conflict (session_id, org_id) do update
      set revoked_at = excluded.revoked_at,
          revocation_reason = excluded.revocation_reason;
  end if;
  return new;
end
$$;

create trigger orgs_status_revoke_sessions
after update of status on orgs
for each row execute function helix_revoke_org_sessions();

revoke execute on function helix_authorize_tenant_session(
  text, text, uuid, uuid, boolean, timestamptz
) from public;
grant execute on function helix_authorize_tenant_session(
  text, text, uuid, uuid, boolean, timestamptz
) to helix_app;
