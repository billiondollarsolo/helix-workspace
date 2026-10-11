-- Reversible account suspension and last sign-in for the admin user directory.
--
-- Suspension reuses the existing membership state: the membership becomes
-- `suspended` and the tenant actor is disabled. Disabling the actor already
-- revokes the person's sessions in this tenant (helix_revoke_identity_sessions)
-- and every credential lookup (API keys, app passwords, S3 keys, OAuth
-- clients, sign-in) already refuses disabled actors. Restore only reverses a
-- suspension: offboarded (deprovisioned) memberships stay closed.
--
-- A sign-in is recorded when a new session is first admitted into a tenant,
-- which only happens after every sign-in factor has passed.

alter table organization_memberships add column last_sign_in_at timestamptz;

update organization_memberships membership
set last_sign_in_at = access.signed_in_at
from (
  select org_id, actor_id, max(first_seen_at) as signed_in_at
  from auth_session_tenant_access
  group by org_id, actor_id
) access
where membership.org_id = access.org_id and membership.actor_id = access.actor_id;

create function helix_record_tenant_sign_in()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  update organization_memberships
  set last_sign_in_at = new.first_seen_at
  where org_id = new.org_id
    and actor_id = new.actor_id
    and (last_sign_in_at is null or last_sign_in_at < new.first_seen_at);
  return new;
end
$$;
alter function helix_record_tenant_sign_in() owner to helix_migration_owner;
revoke all on function helix_record_tenant_sign_in() from public;

create trigger auth_session_tenant_access_record_sign_in
after insert on auth_session_tenant_access
for each row when (new.revoked_at is null)
execute function helix_record_tenant_sign_in();

-- Shared guard for suspend/restore: tenant context, an account administrator
-- caller, and a person in this workspace. Returns the target's membership
-- status, or null when the person is not in this workspace.
create function helix_lock_user_lifecycle_target(tenant_id uuid, target_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  membership_status text;
begin
  if tenant_id is distinct from public.helix_current_org_id()
    or public.helix_current_actor_id() is null
    or not public.helix_user_address_admin_access(tenant_id, true)
  then
    raise insufficient_privilege using message = 'User administration permission denied.';
  end if;
  -- Serialize with offboarding and other lifecycle changes in this tenant so
  -- the last-administrator check cannot be raced.
  perform pg_advisory_xact_lock(hashtextextended('actor-offboarding:' || tenant_id::text, 0));
  perform 1 from actors where org_id = tenant_id and id = target_id and type = 'user' for update;
  if not found then return null; end if;
  select membership.status into membership_status
  from organization_memberships membership
  where membership.org_id = tenant_id and membership.actor_id = target_id
  for update;
  return membership_status;
end
$$;
alter function helix_lock_user_lifecycle_target(uuid, uuid) owner to helix_migration_owner;
revoke all on function helix_lock_user_lifecycle_target(uuid, uuid) from public;

create function helix_suspend_user(tenant_id uuid, target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  membership_status text;
  open_sessions integer;
  suspension_time timestamptz := now();
begin
  membership_status := public.helix_lock_user_lifecycle_target(tenant_id, target_id);
  if membership_status is null then return null; end if;
  if target_id = public.helix_current_actor_id() then
    raise check_violation using message = 'You can''t suspend your own account.';
  end if;
  if membership_status = 'deprovisioned' then
    raise check_violation using message = 'This account was removed and can''t be suspended.';
  end if;
  if membership_status = 'suspended' then
    return jsonb_build_object('actorId', target_id, 'status', 'suspended', 'changed', false,
      'sessionsRevoked', 0);
  end if;
  if public.helix_actor_is_account_admin(tenant_id, target_id) and not exists (
    select 1 from actors actor where actor.org_id = tenant_id and actor.id <> target_id
      and public.helix_actor_is_account_admin(tenant_id, actor.id)
  ) then
    raise check_violation using
      message = 'The last active workspace administrator can''t be suspended.';
  end if;

  select count(*) into open_sessions
  from auth_session_tenant_access access
  join "session" s on s.id = access.session_id
  where access.org_id = tenant_id and access.actor_id = target_id
    and access.revoked_at is null and s."expiresAt" > suspension_time;

  update organization_memberships
  set status = 'suspended', suspended_at = suspension_time, updated_at = now()
  where org_id = tenant_id and actor_id = target_id;
  -- Disabling the actor revokes its tenant sessions and stops every credential.
  update actors set disabled_at = suspension_time, updated_at = now()
  where org_id = tenant_id and id = target_id;
  delete from chat_websocket_tickets where org_id = tenant_id and actor_id = target_id;

  insert into activity (org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash)
  values (tenant_id, public.helix_current_actor_id(), 'identity.user.suspended', 'actor', target_id,
    jsonb_build_object('sessionsRevoked', open_sessions), null, '');
  return jsonb_build_object('actorId', target_id, 'status', 'suspended', 'changed', true,
    'sessionsRevoked', open_sessions);
end
$$;
alter function helix_suspend_user(uuid, uuid) owner to helix_migration_owner;
revoke all on function helix_suspend_user(uuid, uuid) from public;
grant execute on function helix_suspend_user(uuid, uuid) to helix_app;

create function helix_restore_user(tenant_id uuid, target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  membership_status text;
begin
  membership_status := public.helix_lock_user_lifecycle_target(tenant_id, target_id);
  if membership_status is null then return null; end if;
  if membership_status = 'deprovisioned' then
    raise check_violation using message = 'This account was removed and can''t be restored.';
  end if;
  if membership_status = 'active' then
    return jsonb_build_object('actorId', target_id, 'status', 'active', 'changed', false);
  end if;

  update organization_memberships
  set status = 'active', suspended_at = null, updated_at = now()
  where org_id = tenant_id and actor_id = target_id;
  update actors set disabled_at = null, updated_at = now()
  where org_id = tenant_id and id = target_id;

  insert into activity (org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash)
  values (tenant_id, public.helix_current_actor_id(), 'identity.user.restored', 'actor', target_id,
    '{}'::jsonb, null, '');
  return jsonb_build_object('actorId', target_id, 'status', 'active', 'changed', true);
end
$$;
alter function helix_restore_user(uuid, uuid) owner to helix_migration_owner;
revoke all on function helix_restore_user(uuid, uuid) from public;
grant execute on function helix_restore_user(uuid, uuid) to helix_app;
