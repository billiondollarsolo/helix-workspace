-- Every person in an organization can read and change their own profile and
-- personal preferences (account.preferences.*, self-service app passwords).
-- Until now no role carried profile.read/profile.write for ordinary members:
-- only seeded demo logins held them as direct actor scopes.
--
-- The built-in `workspace_member` role holds exactly those two permissions.
-- Every active human membership holds it implicitly at org scope, so no
-- per-member binding rows exist and a new member has it from their first
-- request. The same grant adds the narrow calendar companions of access the
-- person already has: calendar.read brings calendar.read:freebusy and
-- calendar.write brings calendar.write:respond. Deriving them here, rather
-- than rewriting actors.scopes, keeps every session alive: a scope update
-- revokes the person's sessions (0121). Agents and service accounts have no membership and never receive
-- it; OAuth grants and app passwords still cap it to their own scopes. A deny
-- in another role still wins, as for any binding.
--
-- The IAM model stays append-only: role and permission rows are only inserted
-- (their update guards stay in force) and no trigger is disabled.

do $$
begin
  if exists (
    select 1 from iam_roles where role_key = 'workspace_member' and kind <> 'built_in'
  ) then
    raise integrity_constraint_violation using
      message = 'role key workspace_member is reserved for the built-in member role; rename the custom role first';
  end if;
end
$$;

-- Body matches 0203 plus the member role.
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

  insert into iam_roles (org_id, role_key, display_name, kind, description)
  values (input_org_id, 'workspace_member', 'Member', 'built_in',
          'Held by every active person in the organization: read and update their own profile and preferences.')
  on conflict (org_id, role_key) do nothing;
  select id into built_in_role_id
  from iam_roles
  where org_id = input_org_id and role_key = 'workspace_member' and kind = 'built_in';
  if built_in_role_id is null then
    raise integrity_constraint_violation using
      message = 'role key workspace_member is reserved for the built-in member role';
  end if;
  insert into iam_role_permissions (org_id, role_id, permission, effect)
  values
    (input_org_id, built_in_role_id, 'profile.read', 'allow'),
    (input_org_id, built_in_role_id, 'profile.write', 'allow')
  on conflict do nothing;
end
$$;

select helix_ensure_builtin_iam_roles(id) from orgs;

-- Body matches 0161 plus the implicit member grant.
create or replace function helix_actor_role_bindings(input_org_id uuid, input_actor_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select coalesce(jsonb_agg(grants.entry order by grants.implicit, grants.sort_key), '[]'::jsonb)
  from (
    select false as implicit, binding.id as sort_key, jsonb_build_object(
      'roleId', binding.role_id,
      'allow', coalesce(permission_set.allow_permissions, '[]'::jsonb),
      'deny', coalesce(permission_set.deny_permissions, '[]'::jsonb),
      'scopeType', binding.scope_type,
      'scopeId', coalesce(binding.org_unit_id::text, binding.group_id::text, binding.resource_id),
      'resourceType', binding.resource_type
    ) as entry
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
    union all
    select true, role.id, jsonb_build_object(
      'roleId', role.id,
      'allow', coalesce(permission_set.allow_permissions, '[]'::jsonb),
      'deny', coalesce(permission_set.deny_permissions, '[]'::jsonb),
      'scopeType', 'org',
      'scopeId', null,
      'resourceType', null
    )
    from iam_roles role
    join organization_memberships membership
      on membership.org_id = role.org_id
      and membership.actor_id = input_actor_id
      and membership.status = 'active'
    join actors person
      on person.org_id = membership.org_id
      and person.id = membership.actor_id
      and person.type = 'user'
      and person.disabled_at is null
    cross join lateral (
      select
        jsonb_agg(granted.permission order by granted.permission)
          filter (where granted.effect = 'allow') as allow_permissions,
        jsonb_agg(granted.permission order by granted.permission)
          filter (where granted.effect = 'deny') as deny_permissions
      from (
        select permission.permission, permission.effect
        from iam_role_permissions permission
        where permission.org_id = role.org_id and permission.role_id = role.id
        union
        -- Narrow companions of calendar access the person already holds:
        -- seeing free/busy and answering invitations.
        select derived.permission, 'allow'
        from (values
          ('calendar.read', 'calendar.read:freebusy'),
          ('calendar.write', 'calendar.write:respond')
        ) derived(base, permission)
        where derived.base = any(person.scopes)
      ) granted
    ) permission_set
    where role.org_id = input_org_id
      and role.role_key = 'workspace_member'
      and role.kind = 'built_in'
  ) grants
$$;
