-- Delegated administration is a strict tree of immutable role bindings. A
-- child can contain only permissions and structural scope held by its explicit
-- delegable parent. Runtime roles can mutate IAM state only through the
-- checked functions below; every grant and revoke is appended to a WORM log.

insert into iam_permission_catalog (permission, catalog_version) values
  ('admin.helpdesk', 2),
  ('admin.groups', 2),
  ('admin.domains', 2),
  ('admin.security', 2),
  ('admin.billing', 2),
  ('admin.retention', 2)
on conflict (permission) do nothing;

alter table iam_role_bindings
  add column can_delegate boolean not null default false,
  add column granted_by_actor_id uuid,
  add column parent_binding_id uuid,
  add column revoked_at timestamptz,
  add column revoked_by_actor_id uuid,
  add constraint iam_role_bindings_org_id_id_unique unique (org_id, id),
  add constraint iam_role_bindings_grantor_org_fk
    foreign key (org_id, granted_by_actor_id) references actors(org_id, id),
  add constraint iam_role_bindings_parent_org_fk
    foreign key (org_id, parent_binding_id) references iam_role_bindings(org_id, id),
  add constraint iam_role_bindings_revoker_org_fk
    foreign key (org_id, revoked_by_actor_id) references actors(org_id, id),
  add constraint iam_role_bindings_delegation_shape check (
    (granted_by_actor_id is null and parent_binding_id is null)
    or (granted_by_actor_id is not null and parent_binding_id is not null)
  ),
  add constraint iam_role_bindings_revocation_shape check (
    (revoked_at is null and revoked_by_actor_id is null)
    or (revoked_at is not null and revoked_by_actor_id is not null)
  );

create index iam_role_bindings_parent_idx
  on iam_role_bindings (org_id, parent_binding_id)
  where parent_binding_id is not null;

create table iam_delegation_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  binding_id uuid not null,
  event_type text not null check (event_type in ('granted', 'revoked')),
  actor_id text,
  parent_binding_id uuid,
  binding_snapshot jsonb not null,
  created_at timestamptz not null default now()
);

create index iam_delegation_events_org_created_idx
  on iam_delegation_events (org_id, created_at, id);

create function helix_iam_binding_snapshot(binding iam_role_bindings)
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
    'scopeType', binding.scope_type,
    'orgUnitId', binding.org_unit_id,
    'groupId', binding.group_id,
    'resourceType', binding.resource_type,
    'resourceId', binding.resource_id,
    'canDelegate', binding.can_delegate,
    'revokedAt', binding.revoked_at
  )
$$;

create function helix_audit_iam_binding_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    insert into iam_delegation_events (
      org_id, binding_id, event_type, actor_id, parent_binding_id, binding_snapshot
    ) values (
      new.org_id, new.id, 'granted', new.granted_by_actor_id,
      new.parent_binding_id, helix_iam_binding_snapshot(new)
    );
  elsif old.revoked_at is null and new.revoked_at is not null then
    insert into iam_delegation_events (
      org_id, binding_id, event_type, actor_id, parent_binding_id, binding_snapshot
    ) values (
      new.org_id, new.id, 'revoked', new.revoked_by_actor_id,
      new.parent_binding_id, helix_iam_binding_snapshot(new)
    );
  end if;
  return new;
end
$$;

insert into iam_delegation_events (
  org_id, binding_id, event_type, actor_id, parent_binding_id, binding_snapshot, created_at
)
select org_id, id, 'granted', granted_by_actor_id, parent_binding_id,
       helix_iam_binding_snapshot(binding), created_at
from iam_role_bindings binding;

create trigger iam_role_bindings_audit
after insert or update of revoked_at on iam_role_bindings
for each row execute function helix_audit_iam_binding_change();

create function helix_block_iam_delegation_event_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise integrity_constraint_violation using
    message = 'iam_delegation_events is append-only';
end
$$;

create trigger iam_delegation_events_no_update_or_delete
before update or delete on iam_delegation_events
for each row execute function helix_block_iam_delegation_event_mutation();
create trigger iam_delegation_events_no_truncate
before truncate on iam_delegation_events
for each statement execute function helix_block_iam_delegation_event_mutation();

create function helix_block_iam_role_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise integrity_constraint_violation using message = 'IAM roles are immutable';
end
$$;

create trigger iam_roles_no_update
before update on iam_roles
for each row execute function helix_block_iam_role_mutation();
create trigger iam_role_permissions_no_update
before update on iam_role_permissions
for each row execute function helix_block_iam_role_mutation();

create function helix_guard_iam_binding_mutation()
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

create trigger iam_role_bindings_immutable
before update on iam_role_bindings
for each row execute function helix_guard_iam_binding_mutation();

create function helix_iam_actor_owns_binding(
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

create function helix_iam_permission_within_ceiling(
  input_org_id uuid,
  input_actor_id uuid,
  input_ceiling_binding_id uuid,
  input_permission text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from iam_role_bindings ceiling
    join iam_role_permissions held
      on held.org_id = ceiling.org_id and held.role_id = ceiling.role_id
    where ceiling.org_id = input_org_id
      and ceiling.id = input_ceiling_binding_id
      and ceiling.revoked_at is null
      and held.permission = input_permission
      and held.effect = 'allow'
  ) and not exists (
    select 1
    from iam_role_bindings denied_binding
    join iam_role_permissions denied
      on denied.org_id = denied_binding.org_id and denied.role_id = denied_binding.role_id
    join iam_role_bindings ceiling
      on ceiling.org_id = denied_binding.org_id and ceiling.id = input_ceiling_binding_id
    where denied_binding.org_id = input_org_id
      and denied_binding.revoked_at is null
      and denied.permission = input_permission
      and denied.effect = 'deny'
      and (
        denied_binding.service_account_actor_id = input_actor_id
        or exists (
          select 1 from organization_memberships membership
          where membership.org_id = denied_binding.org_id
            and membership.id = denied_binding.membership_id
            and membership.actor_id = input_actor_id
            and membership.status = 'active'
        )
      )
      and (
        denied_binding.scope_type = 'org'
        or (denied_binding.scope_type = ceiling.scope_type and (
          (ceiling.scope_type = 'org_unit'
            and denied_binding.org_unit_id = ceiling.org_unit_id)
          or (ceiling.scope_type = 'group'
            and denied_binding.group_id = ceiling.group_id)
          or (ceiling.scope_type = 'resource'
            and denied_binding.resource_type = ceiling.resource_type
            and denied_binding.resource_id = ceiling.resource_id)
        ))
      )
  )
$$;

create function helix_iam_role_within_ceiling(
  input_org_id uuid,
  input_actor_id uuid,
  input_role_id uuid,
  input_ceiling_binding_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (select 1 from iam_roles where org_id = input_org_id and id = input_role_id)
    and not exists (
      select 1
      from iam_role_permissions requested
      where requested.org_id = input_org_id
        and requested.role_id = input_role_id
        and not helix_iam_permission_within_ceiling(
          input_org_id, input_actor_id, input_ceiling_binding_id, requested.permission
        )
    )
$$;

create function helix_iam_scope_within_ceiling(
  input_org_id uuid,
  input_ceiling_binding_id uuid,
  input_scope_type text,
  input_org_unit_id uuid,
  input_group_id uuid,
  input_resource_type text,
  input_resource_id text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce((
    select case ceiling.scope_type
      when 'org' then true
      when 'org_unit' then input_scope_type = 'org_unit'
        and input_org_unit_id = ceiling.org_unit_id
      when 'group' then input_scope_type = 'group'
        and input_group_id = ceiling.group_id
      when 'resource' then input_scope_type = 'resource'
        and input_resource_type = ceiling.resource_type
        and input_resource_id = ceiling.resource_id
      else false
    end
    from iam_role_bindings ceiling
    where ceiling.org_id = input_org_id
      and ceiling.id = input_ceiling_binding_id
      and ceiling.revoked_at is null
  ), false)
$$;

create function helix_create_custom_iam_role(
  input_org_id uuid,
  input_grantor_actor_id uuid,
  input_ceiling_binding_id uuid,
  input_role_key text,
  input_display_name text,
  input_description text,
  input_allow_permissions text[],
  input_deny_permissions text[]
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_role_id uuid;
  requested_permission text;
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
  if input_allow_permissions && input_deny_permissions then
    raise check_violation using message = 'permission cannot be both allowed and denied';
  end if;
  foreach requested_permission in array input_allow_permissions || input_deny_permissions loop
    if not helix_iam_permission_within_ceiling(
      input_org_id, input_grantor_actor_id,
      input_ceiling_binding_id, requested_permission
    ) then
      raise insufficient_privilege using message = 'role permission exceeds delegation ceiling';
    end if;
  end loop;

  insert into iam_roles (org_id, role_key, display_name, kind, description)
  values (input_org_id, input_role_key, input_display_name, 'custom', input_description)
  returning id into new_role_id;

  insert into iam_role_permissions (org_id, role_id, permission, effect)
  select input_org_id, new_role_id, permission, 'allow'
  from unnest(input_allow_permissions) permission
  union all
  select input_org_id, new_role_id, permission, 'deny'
  from unnest(input_deny_permissions) permission;
  return new_role_id;
end
$$;

create function helix_grant_delegated_iam_binding(
  input_org_id uuid,
  input_grantor_actor_id uuid,
  input_ceiling_binding_id uuid,
  input_role_id uuid,
  input_principal_type text,
  input_membership_id uuid,
  input_service_account_actor_id uuid,
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
    scope_type, org_unit_id, group_id, resource_type, resource_id,
    can_delegate, granted_by_actor_id, parent_binding_id
  ) values (
    input_org_id, input_role_id, input_principal_type, input_membership_id,
    input_service_account_actor_id, input_scope_type, input_org_unit_id,
    input_group_id, input_resource_type, input_resource_id, input_can_delegate,
    input_grantor_actor_id, input_ceiling_binding_id
  )
  returning id into new_binding_id;
  return new_binding_id;
end
$$;

create function helix_revoke_delegated_iam_binding(
  input_org_id uuid,
  input_grantor_actor_id uuid,
  input_binding_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target iam_role_bindings;
begin
  if public.helix_current_org_id() is distinct from input_org_id
    or public.helix_current_actor_id() is distinct from input_grantor_actor_id
  then
    raise insufficient_privilege using message = 'delegation context does not match grantor';
  end if;
  select * into target
  from iam_role_bindings
  where org_id = input_org_id and id = input_binding_id and revoked_at is null;
  if not found
    or target.granted_by_actor_id is distinct from input_grantor_actor_id
    or not helix_iam_actor_owns_binding(
      input_org_id, input_grantor_actor_id, target.parent_binding_id
    )
  then
    raise insufficient_privilege using message = 'grantor cannot revoke this binding';
  end if;

  with recursive descendants as (
    select id from iam_role_bindings
    where org_id = input_org_id and id = input_binding_id
    union all
    select child.id
    from iam_role_bindings child
    join descendants parent on child.parent_binding_id = parent.id
    where child.org_id = input_org_id and child.revoked_at is null
  )
  update iam_role_bindings binding
  set revoked_at = now(), revoked_by_actor_id = input_grantor_actor_id
  where binding.org_id = input_org_id
    and binding.id in (select id from descendants)
    and binding.revoked_at is null;
end
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
      (
        binding.service_account_actor_id = input_actor_id
        and exists (
          select 1 from actors service_account
          where service_account.org_id = binding.org_id
            and service_account.id = binding.service_account_actor_id
            and service_account.type = 'service_account'
            and service_account.disabled_at is null
        )
      )
      or exists (
        select 1 from organization_memberships membership
        where membership.org_id = binding.org_id
          and membership.id = binding.membership_id
          and membership.actor_id = input_actor_id
          and membership.status = 'active'
      )
    )
$$;

create or replace function helix_ensure_builtin_iam_roles(input_org_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  built_in record;
  built_in_role_id uuid;
begin
  for built_in in
    select * from (values
      ('workspace_viewer', 'Workspace viewer', 'platform.read'),
      ('helpdesk_admin', 'Helpdesk administrator', 'admin.helpdesk'),
      ('user_admin', 'User administrator', 'admin.users'),
      ('group_admin', 'Group administrator', 'admin.groups'),
      ('domain_admin', 'Domain administrator', 'admin.domains'),
      ('security_admin', 'Security administrator', 'admin.security'),
      ('audit_admin', 'Audit administrator', 'admin.audit'),
      ('billing_admin', 'Billing administrator', 'admin.billing'),
      ('retention_admin', 'Retention administrator', 'admin.retention'),
      ('mail_admin', 'Mail administrator', 'mail.admin')
    ) definition(role_key, display_name, permission)
  loop
    insert into iam_roles (org_id, role_key, display_name, kind, description)
    values (input_org_id, built_in.role_key, built_in.display_name, 'built_in',
            'Built-in exact delegated administration role.')
    on conflict (org_id, role_key) do nothing;
    select id into built_in_role_id
    from iam_roles
    where org_id = input_org_id and role_key = built_in.role_key;
    insert into iam_role_permissions (org_id, role_id, permission, effect)
    values (input_org_id, built_in_role_id, built_in.permission, 'allow')
    on conflict do nothing;
  end loop;

  select id into built_in_role_id
  from iam_roles where org_id = input_org_id and role_key = 'workspace_viewer';
  insert into iam_role_permissions (org_id, role_id, permission, effect)
  values
    (input_org_id, built_in_role_id, 'profile.read', 'allow'),
    (input_org_id, built_in_role_id, 'tools:read', 'allow')
  on conflict do nothing;
end
$$;

select helix_ensure_builtin_iam_roles(id) from orgs;

alter table iam_delegation_events enable row level security;
alter table iam_delegation_events force row level security;
create policy helix_tenant_isolation on iam_delegation_events
  using (org_id = helix_current_org_id());

alter table iam_delegation_events owner to helix_migration_owner;
alter function helix_iam_binding_snapshot(iam_role_bindings) owner to helix_migration_owner;
alter function helix_audit_iam_binding_change() owner to helix_migration_owner;
alter function helix_block_iam_delegation_event_mutation() owner to helix_migration_owner;
alter function helix_block_iam_role_mutation() owner to helix_migration_owner;
alter function helix_guard_iam_binding_mutation() owner to helix_migration_owner;
alter function helix_iam_actor_owns_binding(uuid, uuid, uuid) owner to helix_migration_owner;
alter function helix_iam_permission_within_ceiling(uuid, uuid, uuid, text)
  owner to helix_migration_owner;
alter function helix_iam_role_within_ceiling(uuid, uuid, uuid, uuid)
  owner to helix_migration_owner;
alter function helix_iam_scope_within_ceiling(uuid, uuid, text, uuid, uuid, text, text)
  owner to helix_migration_owner;
alter function helix_create_custom_iam_role(uuid, uuid, uuid, text, text, text, text[], text[])
  owner to helix_migration_owner;
alter function helix_grant_delegated_iam_binding(
  uuid, uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, text, boolean
) owner to helix_migration_owner;
alter function helix_revoke_delegated_iam_binding(uuid, uuid, uuid)
  owner to helix_migration_owner;
alter function helix_actor_role_bindings(uuid, uuid) owner to helix_migration_owner;
alter function helix_ensure_builtin_iam_roles(uuid) owner to helix_migration_owner;

revoke insert, update, delete on iam_roles, iam_role_permissions, iam_role_bindings
  from helix_app, helix_worker;
revoke all on iam_delegation_events from public;
grant select on iam_roles, iam_role_permissions, iam_role_bindings, iam_delegation_events
  to helix_app, helix_worker, helix_readonly;

revoke execute on function helix_create_custom_iam_role(
  uuid, uuid, uuid, text, text, text, text[], text[]
) from public;
revoke execute on function helix_grant_delegated_iam_binding(
  uuid, uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, text, boolean
) from public;
revoke execute on function helix_revoke_delegated_iam_binding(uuid, uuid, uuid) from public;
grant execute on function helix_create_custom_iam_role(
  uuid, uuid, uuid, text, text, text, text[], text[]
) to helix_app, helix_worker;
grant execute on function helix_grant_delegated_iam_binding(
  uuid, uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, text, boolean
) to helix_app, helix_worker;
grant execute on function helix_revoke_delegated_iam_binding(uuid, uuid, uuid)
  to helix_app, helix_worker;
