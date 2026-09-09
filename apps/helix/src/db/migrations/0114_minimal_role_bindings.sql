-- One tenant-scoped role model for human memberships and service accounts.
-- Permissions are exact catalog entries. Binding scope is structural (never a
-- string prefix), and the runtime evaluator applies deny-overrides.

create table iam_permission_catalog (
  permission text primary key,
  catalog_version integer not null check (catalog_version > 0)
);

insert into iam_permission_catalog (permission, catalog_version) values
  ('platform.read', 1), ('tools:read', 1), ('tools:write', 1),
  ('profile.read', 1), ('profile.write', 1),
  ('mail.read', 1), ('mail.read:shared', 1), ('mail.send', 1),
  ('mail.write', 1), ('mail.delete', 1), ('mail.admin', 1),
  ('mail.external', 1), ('mail.system', 1),
  ('drive.read', 1), ('drive.read:shared', 1), ('drive.write', 1),
  ('drive.write:shared', 1), ('drive.delete', 1),
  ('chat.read', 1), ('chat.post', 1), ('chat.create', 1),
  ('calendar.read', 1), ('calendar.read:freebusy', 1),
  ('calendar.write', 1), ('calendar.manage', 1),
  ('calendar.write:respond', 1), ('calendar.external', 1),
  ('docs.read', 1), ('docs.write', 1), ('docs.comment', 1),
  ('sheets.read', 1), ('sheets.write', 1),
  ('slides.read', 1), ('slides.write', 1),
  ('meet.read', 1), ('meet.write', 1),
  ('notifications.read', 1), ('notifications.write', 1),
  ('assistant.read', 1), ('assistant.write', 1), ('assistant.memory', 1),
  ('admin.users', 1), ('admin.config', 1), ('admin.config.read', 1),
  ('admin.config.write', 1), ('admin.audit', 1), ('admin.plugins', 1),
  ('admin.webhooks', 1), ('admin.agents', 1), ('admin.console.read', 1),
  ('admin.console.write', 1), ('admin.services.read', 1), ('admin.ai', 1),
  ('admin.search.write', 1), ('admin.tenants.read', 1),
  ('admin.tenants.export', 1), ('admin.tenants.write', 1),
  ('admin.tenants.delete', 1), ('admin.*', 1), ('admin.config.*', 1),
  ('admin.search.*', 1), ('caldav', 1), ('carddav.read', 1),
  ('carddav.write', 1), ('webdav', 1), ('imap', 1), ('smtp', 1);

create table iam_roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  role_key text not null check (role_key ~ '^[a-z][a-z0-9_-]{0,62}$'),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 120),
  kind text not null check (kind in ('built_in', 'custom')),
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, role_key)
);

create table iam_role_permissions (
  org_id uuid not null,
  role_id uuid not null,
  permission text not null references iam_permission_catalog(permission) on delete restrict,
  effect text not null check (effect in ('allow', 'deny')),
  primary key (org_id, role_id, permission),
  foreign key (org_id, role_id) references iam_roles(org_id, id) on delete cascade
);

create unique index if not exists organization_memberships_org_id_id_unique_idx
  on organization_memberships (org_id, id);
create unique index if not exists admin_groups_org_id_id_unique_idx
  on admin_groups (org_id, id);

create table iam_role_bindings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  role_id uuid not null,
  principal_type text not null check (principal_type in ('membership', 'service_account')),
  membership_id uuid,
  service_account_actor_id uuid,
  scope_type text not null check (scope_type in ('org', 'org_unit', 'group', 'resource')),
  org_unit_id uuid,
  group_id uuid,
  resource_type text,
  resource_id text,
  created_at timestamptz not null default now(),
  foreign key (org_id, role_id) references iam_roles(org_id, id) on delete cascade,
  foreign key (org_id, membership_id)
    references organization_memberships(org_id, id) on delete cascade,
  foreign key (org_id, service_account_actor_id)
    references actors(org_id, id) on delete cascade,
  foreign key (org_id, org_unit_id)
    references admin_org_units(org_id, id) on delete cascade,
  foreign key (org_id, group_id)
    references admin_groups(org_id, id) on delete cascade,
  constraint iam_role_bindings_principal_shape check (
    (principal_type = 'membership' and membership_id is not null and service_account_actor_id is null)
    or
    (principal_type = 'service_account' and membership_id is null and service_account_actor_id is not null)
  ),
  constraint iam_role_bindings_scope_shape check (
    (scope_type = 'org' and org_unit_id is null and group_id is null
      and resource_type is null and resource_id is null)
    or
    (scope_type = 'org_unit' and org_unit_id is not null and group_id is null
      and resource_type is null and resource_id is null)
    or
    (scope_type = 'group' and org_unit_id is null and group_id is not null
      and resource_type is null and resource_id is null)
    or
    (scope_type = 'resource' and org_unit_id is null and group_id is null
      and resource_type ~ '^[a-z][a-z0-9_.:-]{0,127}$'
      and char_length(resource_id) between 1 and 512)
  )
);

create index iam_role_bindings_membership_idx
  on iam_role_bindings (org_id, membership_id) where membership_id is not null;
create index iam_role_bindings_service_account_idx
  on iam_role_bindings (org_id, service_account_actor_id)
  where service_account_actor_id is not null;

create function helix_validate_iam_service_account_binding()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.principal_type = 'service_account' and not exists (
    select 1 from actors
    where org_id = new.org_id
      and id = new.service_account_actor_id
      and type = 'service_account'
      and disabled_at is null
  ) then
    raise check_violation using
      constraint = 'iam_role_bindings_service_account_type',
      message = 'role binding principal must be an active service account';
  end if;
  return new;
end
$$;

create trigger iam_role_bindings_validate_service_account
before insert or update on iam_role_bindings
for each row execute function helix_validate_iam_service_account_binding();

create function helix_ensure_builtin_iam_roles(input_org_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  viewer_role_id uuid;
begin
  insert into iam_roles (org_id, role_key, display_name, kind, description)
  values (input_org_id, 'workspace_viewer', 'Workspace viewer', 'built_in',
          'Read-only access to platform metadata, profile, and tool discovery.')
  on conflict (org_id, role_key) do update set updated_at = iam_roles.updated_at
  returning id into viewer_role_id;

  insert into iam_role_permissions (org_id, role_id, permission, effect)
  values
    (input_org_id, viewer_role_id, 'platform.read', 'allow'),
    (input_org_id, viewer_role_id, 'profile.read', 'allow'),
    (input_org_id, viewer_role_id, 'tools:read', 'allow')
  on conflict do nothing;
end
$$;

select helix_ensure_builtin_iam_roles(id) from orgs;

create function helix_seed_builtin_iam_roles()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform helix_ensure_builtin_iam_roles(new.id);
  return new;
end
$$;

create trigger orgs_seed_builtin_iam_roles
after insert on orgs
for each row execute function helix_seed_builtin_iam_roles();

create function helix_actor_role_bindings(input_org_id uuid, input_actor_id uuid)
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

alter table iam_roles enable row level security;
alter table iam_roles force row level security;
create policy helix_tenant_isolation on iam_roles
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

alter table iam_role_permissions enable row level security;
alter table iam_role_permissions force row level security;
create policy helix_tenant_isolation on iam_role_permissions
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

alter table iam_role_bindings enable row level security;
alter table iam_role_bindings force row level security;
create policy helix_tenant_isolation on iam_role_bindings
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

alter table iam_permission_catalog owner to helix_migration_owner;
alter table iam_roles owner to helix_migration_owner;
alter table iam_role_permissions owner to helix_migration_owner;
alter table iam_role_bindings owner to helix_migration_owner;
alter function helix_validate_iam_service_account_binding() owner to helix_migration_owner;
alter function helix_ensure_builtin_iam_roles(uuid) owner to helix_migration_owner;
alter function helix_seed_builtin_iam_roles() owner to helix_migration_owner;
alter function helix_actor_role_bindings(uuid, uuid) owner to helix_migration_owner;

revoke all on iam_permission_catalog, iam_roles, iam_role_permissions, iam_role_bindings
  from public;
grant select on iam_permission_catalog to helix_app, helix_worker, helix_readonly;
grant select, insert, update, delete on iam_roles, iam_role_permissions, iam_role_bindings
  to helix_app, helix_worker;
grant select on iam_roles, iam_role_permissions, iam_role_bindings to helix_readonly;

revoke execute on function helix_validate_iam_service_account_binding() from public;
revoke execute on function helix_ensure_builtin_iam_roles(uuid) from public;
revoke execute on function helix_seed_builtin_iam_roles() from public;
revoke execute on function helix_actor_role_bindings(uuid, uuid) from public;
grant execute on function helix_actor_role_bindings(uuid, uuid) to helix_app, helix_worker;
