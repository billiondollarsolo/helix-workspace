-- Directory groups are principals, not an admin-only facade. One canonical
-- membership resolver drives RBAC and materialized product access. Membership
-- changes refresh effective access in the same transaction.

create function helix_directory_group_contains(
  input_org_id uuid,
  input_group_id uuid,
  input_actor_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from admin_group_members member
    join actors actor
      on actor.org_id = member.org_id and actor.id = member.actor_id
    left join organization_memberships membership
      on membership.org_id = actor.org_id and membership.actor_id = actor.id
    where member.org_id = input_org_id
      and member.group_id = input_group_id
      and member.actor_id = input_actor_id
      and actor.disabled_at is null
      and (actor.type <> 'user' or membership.status = 'active')
  )
$$;

-- IAM: allow a group itself to hold a role binding. Actor snapshots expand the
-- binding at read time, so removals take effect on the next authorization check.
alter table iam_role_bindings
  add column principal_group_id uuid,
  drop constraint iam_role_bindings_principal_shape,
  drop constraint iam_role_bindings_principal_type_check,
  add constraint iam_role_bindings_principal_type_check
    check (principal_type in ('membership', 'service_account', 'group')),
  add constraint iam_role_bindings_principal_group_org_fk
    foreign key (org_id, principal_group_id)
    references admin_groups(org_id, id) on delete cascade,
  add constraint iam_role_bindings_principal_shape check (
    (principal_type = 'membership' and membership_id is not null
      and service_account_actor_id is null and principal_group_id is null)
    or
    (principal_type = 'service_account' and membership_id is null
      and service_account_actor_id is not null and principal_group_id is null)
    or
    (principal_type = 'group' and membership_id is null
      and service_account_actor_id is null and principal_group_id is not null)
  );

create index iam_role_bindings_principal_group_idx
  on iam_role_bindings (org_id, principal_group_id)
  where principal_group_id is not null;

create or replace function helix_iam_binding_snapshot(binding iam_role_bindings)
returns jsonb
language sql
immutable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'bindingId', binding.id,
    'roleId', binding.role_id,
    'principalType', binding.principal_type,
    'membershipId', binding.membership_id,
    'serviceAccountActorId', binding.service_account_actor_id,
    'principalGroupId', binding.principal_group_id,
    'scopeType', binding.scope_type,
    'orgUnitId', binding.org_unit_id,
    'groupId', binding.group_id,
    'resourceType', binding.resource_type,
    'resourceId', binding.resource_id,
    'canDelegate', binding.can_delegate,
    'revokedAt', binding.revoked_at
  )
$$;

create or replace function helix_guard_iam_binding_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.revoked_at is null
    and new.revoked_at is not null
    and new.revoked_by_actor_id is not null
    and new.id = old.id
    and new.org_id = old.org_id
    and new.role_id = old.role_id
    and new.principal_type = old.principal_type
    and new.membership_id is not distinct from old.membership_id
    and new.service_account_actor_id is not distinct from old.service_account_actor_id
    and new.principal_group_id is not distinct from old.principal_group_id
    and new.scope_type = old.scope_type
    and new.org_unit_id is not distinct from old.org_unit_id
    and new.group_id is not distinct from old.group_id
    and new.resource_type is not distinct from old.resource_type
    and new.resource_id is not distinct from old.resource_id
    and new.created_at = old.created_at
    and new.can_delegate = old.can_delegate
    and new.granted_by_actor_id is not distinct from old.granted_by_actor_id
    and new.parent_binding_id is not distinct from old.parent_binding_id
  then
    return new;
  end if;
  raise integrity_constraint_violation using message = 'IAM bindings are immutable except for revoke';
end
$$;

create or replace function helix_iam_actor_owns_binding(
  input_org_id uuid,
  input_actor_id uuid,
  input_binding_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from iam_role_bindings binding
    where binding.org_id = input_org_id
      and binding.id = input_binding_id
      and binding.revoked_at is null
      and binding.can_delegate
      and (
        binding.service_account_actor_id = input_actor_id
        or helix_directory_group_contains(
          binding.org_id, binding.principal_group_id, input_actor_id
        )
        or exists (
          select 1 from organization_memberships membership
          where membership.org_id = binding.org_id
            and membership.id = binding.membership_id
            and membership.actor_id = input_actor_id
            and membership.status = 'active'
        )
      )
  )
$$;

create or replace function helix_actor_role_bindings(input_org_id uuid, input_actor_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'roleId', binding.role_id,
    'allow', coalesce(permission_set.allow_permissions, '[]'::jsonb),
    'deny', coalesce(permission_set.deny_permissions, '[]'::jsonb),
    'scopeType', binding.scope_type,
    'scopeId', coalesce(binding.org_unit_id::text, binding.group_id::text, binding.resource_id),
    'resourceType', binding.resource_type
  ) order by binding.id), '[]'::jsonb)
  from iam_role_bindings binding
  cross join lateral (
    select
      jsonb_agg(permission.permission order by permission.permission)
        filter (where permission.effect = 'allow') as allow_permissions,
      jsonb_agg(permission.permission order by permission.permission)
        filter (where permission.effect = 'deny') as deny_permissions
    from iam_role_permissions permission
    where permission.org_id = binding.org_id and permission.role_id = binding.role_id
  ) permission_set
  where binding.org_id = input_org_id
    and binding.revoked_at is null
    and (
      (binding.principal_type = 'group' and helix_directory_group_contains(
        binding.org_id, binding.principal_group_id, input_actor_id
      ))
      or (
        binding.principal_type = 'service_account'
        and binding.service_account_actor_id = input_actor_id
        and exists (
          select 1 from actors service_account
          where service_account.org_id = binding.org_id
            and service_account.id = binding.service_account_actor_id
            and service_account.type = 'service_account'
            and service_account.disabled_at is null
        )
      )
      or (
        binding.principal_type = 'membership'
        and exists (
          select 1 from organization_memberships membership
          where membership.org_id = binding.org_id
            and membership.id = binding.membership_id
            and membership.actor_id = input_actor_id
            and membership.status = 'active'
        )
      )
    )
$$;

drop function helix_grant_delegated_iam_binding(
  uuid, uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, text, boolean
);

create function helix_grant_delegated_iam_binding(
  input_org_id uuid,
  input_grantor_actor_id uuid,
  input_ceiling_binding_id uuid,
  input_role_id uuid,
  input_principal_type text,
  input_membership_id uuid,
  input_service_account_actor_id uuid,
  input_principal_group_id uuid,
  input_scope_type text,
  input_org_unit_id uuid,
  input_group_id uuid,
  input_resource_type text,
  input_resource_id text,
  input_can_delegate boolean
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_binding_id uuid;
begin
  if public.helix_current_org_id() is distinct from input_org_id
    or public.helix_current_actor_id() is distinct from input_grantor_actor_id
  then
    raise insufficient_privilege using message = 'delegation context does not match grantor';
  end if;
  if not helix_iam_actor_owns_binding(
    input_org_id, input_grantor_actor_id, input_ceiling_binding_id
  ) then
    raise insufficient_privilege using message = 'delegation ceiling is not held by grantor';
  end if;
  if not helix_iam_role_within_ceiling(
    input_org_id, input_grantor_actor_id, input_role_id, input_ceiling_binding_id
  ) then
    raise insufficient_privilege using message = 'role exceeds delegation permission ceiling';
  end if;
  if not helix_iam_scope_within_ceiling(
    input_org_id, input_ceiling_binding_id, input_scope_type,
    input_org_unit_id, input_group_id, input_resource_type, input_resource_id
  ) then
    raise insufficient_privilege using message = 'scope exceeds delegation ceiling';
  end if;

  insert into iam_role_bindings (
    org_id, role_id, principal_type, membership_id, service_account_actor_id,
    principal_group_id, scope_type, org_unit_id, group_id, resource_type,
    resource_id, can_delegate, granted_by_actor_id, parent_binding_id
  ) values (
    input_org_id, input_role_id, input_principal_type, input_membership_id,
    input_service_account_actor_id, input_principal_group_id, input_scope_type,
    input_org_unit_id, input_group_id, input_resource_type, input_resource_id,
    input_can_delegate, input_grantor_actor_id, input_ceiling_binding_id
  )
  returning id into new_binding_id;
  return new_binding_id;
end
$$;

-- One group grant covers Drive objects, Chat rooms, and Calendars. Existing
-- product read paths keep using their native effective-access tables.
create table directory_group_resource_grants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  group_id uuid not null,
  resource_type text not null check (resource_type in ('object', 'thread', 'calendar')),
  resource_id uuid not null,
  role text not null,
  granted_by_actor_id uuid not null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, group_id, resource_type, resource_id),
  foreign key (org_id, group_id) references admin_groups(org_id, id) on delete cascade,
  foreign key (org_id, granted_by_actor_id) references actors(org_id, id),
  check (expires_at is null or expires_at > created_at)
);

alter table permissions
  add column source_group_grant_id uuid references directory_group_resource_grants(id) on delete cascade;
create unique index permissions_group_grant_actor_idx
  on permissions (source_group_grant_id, actor_id)
  where source_group_grant_id is not null;

alter table cal_calendar_memberships
  add column source_group_grant_id uuid references directory_group_resource_grants(id) on delete cascade;

create function helix_validate_directory_group_grant()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.resource_type = 'object' then
    if new.role not in ('viewer', 'editor') or not exists (
      select 1 from objects where org_id = new.org_id and id = new.resource_id and deleted_at is null
    ) then
      raise check_violation using message = 'invalid Drive group grant';
    end if;
  elsif new.resource_type = 'thread' then
    if new.role not in ('member', 'moderator') or not exists (
      select 1 from threads
      where org_id = new.org_id and id = new.resource_id and kind = 'chat_room' and archived_at is null
    ) then
      raise check_violation using message = 'invalid Chat group grant';
    end if;
  elsif new.resource_type = 'calendar' then
    if new.expires_at is not null or new.role not in ('reader', 'writer') or not exists (
      select 1 from cal_calendars
      where org_id = new.org_id and id = new.resource_id and deleted_at is null
    ) then
      raise check_violation using message = 'invalid Calendar group grant';
    end if;
  end if;
  return new;
end
$$;

create trigger directory_group_grants_validate
before insert or update on directory_group_resource_grants
for each row execute function helix_validate_directory_group_grant();

create function helix_sync_directory_group_calendar(input_org_id uuid, input_calendar_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  delete from cal_calendar_memberships membership
  where membership.org_id = input_org_id
    and membership.calendar_id = input_calendar_id
    and membership.source_group_grant_id is not null;

  insert into cal_calendar_memberships (
    org_id, calendar_id, actor_id, role, source_group_grant_id
  )
  select distinct on (member.actor_id)
    grant_record.org_id,
    grant_record.resource_id,
    member.actor_id,
    grant_record.role::cal_membership_role,
    grant_record.id
  from directory_group_resource_grants grant_record
  join admin_group_members member
    on member.org_id = grant_record.org_id and member.group_id = grant_record.group_id
  join actors actor
    on actor.org_id = member.org_id and actor.id = member.actor_id and actor.disabled_at is null
  left join organization_memberships org_member
    on org_member.org_id = actor.org_id and org_member.actor_id = actor.id
  where grant_record.org_id = input_org_id
    and grant_record.resource_type = 'calendar'
    and grant_record.resource_id = input_calendar_id
    and (grant_record.expires_at is null or grant_record.expires_at > statement_timestamp())
    and (actor.type <> 'user' or org_member.status = 'active')
  order by member.actor_id,
    case grant_record.role when 'writer' then 2 else 1 end desc,
    grant_record.id
  on conflict (actor_id, calendar_id) do nothing;
end
$$;

create function helix_sync_directory_group_grant(input_grant_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  grant_record directory_group_resource_grants;
begin
  select * into grant_record from directory_group_resource_grants where id = input_grant_id;
  if not found then return; end if;

  if grant_record.resource_type = 'calendar' then
    perform helix_sync_directory_group_calendar(grant_record.org_id, grant_record.resource_id);
    return;
  end if;

  delete from permissions permission
  where permission.source_group_grant_id = grant_record.id
    and not helix_directory_group_contains(
      grant_record.org_id, grant_record.group_id, permission.actor_id
    );

  update permissions permission
  set role = grant_record.role,
      granted_by_actor_id = grant_record.granted_by_actor_id,
      expires_at = grant_record.expires_at,
      updated_at = now()
  where permission.source_group_grant_id = grant_record.id;

  insert into permissions (
    org_id, actor_id, resource_type, resource_id, role,
    granted_by_actor_id, expires_at, source_group_grant_id
  )
  select grant_record.org_id, member.actor_id, grant_record.resource_type,
    grant_record.resource_id, grant_record.role, grant_record.granted_by_actor_id,
    grant_record.expires_at, grant_record.id
  from admin_group_members member
  join actors actor
    on actor.org_id = member.org_id and actor.id = member.actor_id and actor.disabled_at is null
  left join organization_memberships org_member
    on org_member.org_id = actor.org_id and org_member.actor_id = actor.id
  where member.org_id = grant_record.org_id
    and member.group_id = grant_record.group_id
    and (actor.type <> 'user' or org_member.status = 'active')
    and (grant_record.expires_at is null or grant_record.expires_at > statement_timestamp())
  on conflict (source_group_grant_id, actor_id)
    where source_group_grant_id is not null do nothing;
end
$$;

create function helix_sync_directory_group_membership()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  grant_id uuid;
begin
  for grant_id in
    select id from directory_group_resource_grants
    where org_id = coalesce(new.org_id, old.org_id)
      and group_id in (coalesce(new.group_id, old.group_id), old.group_id)
  loop
    perform helix_sync_directory_group_grant(grant_id);
  end loop;
  return coalesce(new, old);
end
$$;

create trigger directory_group_members_refresh_access
after insert or update of org_id, group_id, actor_id or delete on admin_group_members
for each row execute function helix_sync_directory_group_membership();

create function helix_sync_directory_group_grant_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    if old.resource_type = 'calendar' then
      perform helix_sync_directory_group_calendar(old.org_id, old.resource_id);
    end if;
    return old;
  end if;
  perform helix_sync_directory_group_grant(new.id);
  if tg_op = 'UPDATE'
    and old.resource_type = 'calendar'
    and row(old.org_id, old.resource_id) is distinct from row(new.org_id, new.resource_id)
  then
    perform helix_sync_directory_group_calendar(old.org_id, old.resource_id);
  end if;
  return new;
end
$$;

create trigger directory_group_grants_refresh_access
after insert or update or delete on directory_group_resource_grants
for each row execute function helix_sync_directory_group_grant_change();

-- Product code cannot make a group-derived grant disappear for one member;
-- membership and the canonical group grant remain the source of truth.
create function helix_repair_deleted_directory_group_permission()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.source_group_grant_id is not null and pg_trigger_depth() = 1 then
    perform helix_sync_directory_group_grant(old.source_group_grant_id);
  end if;
  return old;
end
$$;

create trigger permissions_repair_group_grant
after delete on permissions
for each row execute function helix_repair_deleted_directory_group_permission();

create function helix_repair_deleted_directory_group_calendar()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.source_group_grant_id is not null and pg_trigger_depth() = 1 then
    perform helix_sync_directory_group_calendar(old.org_id, old.calendar_id);
  end if;
  return old;
end
$$;

create trigger cal_memberships_repair_group_grant
after delete on cal_calendar_memberships
for each row execute function helix_repair_deleted_directory_group_calendar();

-- Checked mutation primitive used by every product share surface.
create function helix_grant_directory_group_resource(
  input_org_id uuid,
  input_actor_id uuid,
  input_group_id uuid,
  input_resource_type text,
  input_resource_id uuid,
  input_role text,
  input_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_id uuid;
  authorized boolean := false;
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_actor_id
  then
    raise insufficient_privilege using message = 'group grant context does not match actor';
  end if;
  if not exists (
    select 1 from admin_groups where org_id = input_org_id and id = input_group_id
  ) then
    raise foreign_key_violation using message = 'group is not in this organization';
  end if;

  if input_resource_type = 'object' then
    select exists (
      select 1 from objects object
      where object.org_id = input_org_id and object.id = input_resource_id
        and object.deleted_at is null
        and (object.owner_actor_id = input_actor_id or exists (
          select 1 from permissions permission
          where permission.org_id = input_org_id
            and permission.actor_id = input_actor_id
            and permission.resource_type = 'object'
            and permission.resource_id = input_resource_id
            and permission.role = 'owner'
            and permission.status = 'active'
            and permission.revoked_at is null
            and (permission.expires_at is null or permission.expires_at > statement_timestamp())
        ))
    ) into authorized;
  elsif input_resource_type = 'thread' then
    select exists (
      select 1 from permissions permission
      where chat_permission_is_valid(
        permission, input_org_id, input_actor_id, input_resource_id
      ) and permission.role = 'owner'
    ) into authorized;
  elsif input_resource_type = 'calendar' then
    select exists (
      select 1 from cal_calendars calendar
      where calendar.org_id = input_org_id and calendar.id = input_resource_id
        and calendar.deleted_at is null
        and (calendar.owner_actor_id = input_actor_id or exists (
          select 1 from cal_calendar_memberships membership
          where membership.org_id = input_org_id
            and membership.calendar_id = input_resource_id
            and membership.actor_id = input_actor_id and membership.role = 'owner'
        ))
    ) into authorized;
  end if;
  if not authorized then
    raise insufficient_privilege using message = 'actor cannot share this resource';
  end if;

  insert into directory_group_resource_grants (
    org_id, group_id, resource_type, resource_id, role,
    granted_by_actor_id, expires_at
  ) values (
    input_org_id, input_group_id, input_resource_type, input_resource_id,
    input_role, input_actor_id, input_expires_at
  )
  on conflict (org_id, group_id, resource_type, resource_id) do update
    set role = excluded.role, expires_at = excluded.expires_at,
        granted_by_actor_id = excluded.granted_by_actor_id, updated_at = now()
  returning id into new_id;
  return new_id;
end
$$;

create function helix_revoke_directory_group_resource(
  input_org_id uuid,
  input_actor_id uuid,
  input_grant_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  removed_count integer;
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_actor_id
  then
    raise insufficient_privilege using message = 'group grant context does not match actor';
  end if;
  delete from directory_group_resource_grants grant_record
  where grant_record.org_id = input_org_id
    and grant_record.id = input_grant_id
    and grant_record.granted_by_actor_id = input_actor_id;
  get diagnostics removed_count = row_count;
  return removed_count = 1;
end
$$;

alter table directory_group_resource_grants enable row level security;
alter table directory_group_resource_grants force row level security;
create policy helix_tenant_isolation on directory_group_resource_grants
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

alter table directory_group_resource_grants owner to helix_migration_owner;
alter function helix_directory_group_contains(uuid, uuid, uuid) owner to helix_migration_owner;
alter function helix_validate_directory_group_grant() owner to helix_migration_owner;
alter function helix_sync_directory_group_calendar(uuid, uuid) owner to helix_migration_owner;
alter function helix_sync_directory_group_grant(uuid) owner to helix_migration_owner;
alter function helix_sync_directory_group_membership() owner to helix_migration_owner;
alter function helix_sync_directory_group_grant_change() owner to helix_migration_owner;
alter function helix_repair_deleted_directory_group_permission() owner to helix_migration_owner;
alter function helix_repair_deleted_directory_group_calendar() owner to helix_migration_owner;
alter function helix_grant_directory_group_resource(uuid, uuid, uuid, text, uuid, text, timestamptz)
  owner to helix_migration_owner;
alter function helix_revoke_directory_group_resource(uuid, uuid, uuid)
  owner to helix_migration_owner;
alter function helix_grant_delegated_iam_binding(
  uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, uuid, uuid, text, text, boolean
) owner to helix_migration_owner;

revoke all on directory_group_resource_grants from public;
grant select on directory_group_resource_grants to helix_app, helix_worker, helix_readonly;
revoke execute on function helix_directory_group_contains(uuid, uuid, uuid) from public;
revoke execute on function helix_grant_directory_group_resource(
  uuid, uuid, uuid, text, uuid, text, timestamptz
) from public;
grant execute on function helix_directory_group_contains(uuid, uuid, uuid)
  to helix_app, helix_worker;
grant execute on function helix_grant_directory_group_resource(
  uuid, uuid, uuid, text, uuid, text, timestamptz
) to helix_app, helix_worker;
revoke execute on function helix_revoke_directory_group_resource(uuid, uuid, uuid) from public;
grant execute on function helix_revoke_directory_group_resource(uuid, uuid, uuid)
  to helix_app, helix_worker;
revoke execute on function helix_grant_delegated_iam_binding(
  uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, uuid, uuid, text, text, boolean
) from public;
grant execute on function helix_grant_delegated_iam_binding(
  uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, uuid, uuid, text, text, boolean
) to helix_app;
