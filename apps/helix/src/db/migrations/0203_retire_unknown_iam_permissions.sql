-- Retire every IAM permission the application no longer knows: the billing
-- permission (Helix has no billing, ADR-0030), the editor permissions
-- (docs.*, sheets.*, slides.*; editors are not part of the product) and the
-- unused imap permission. Persisted permission sets that contain an unknown
-- entry fail closed as a unit, so a single stale entry would silently remove
-- an actor's other grants. Every stored copy is removed here.
--
-- "Unknown" is anything in iam_permission_catalog that is not listed below.
-- The list must equal SCOPE_CATALOG in
-- apps/helix/src/platform/permissions/scope-catalog.ts; a live test asserts
-- that the database catalog and the application catalog are identical.
--
-- The IAM model stays append-only where it promises to be:
--   * roles and role permissions are never updated; retired rows are deleted,
--     which their update-only guards allow;
--   * bindings are never edited. A role whose every permission is retired
--     is removed; each active binding to it, and every binding delegated
--     beneath one, is first recorded as revoked in the append-only
--     iam_delegation_events log;
--   * a role that keeps other permissions only loses the retired ones;
--   * no trigger is disabled.

create temporary table retired_iam_permissions on commit drop as
select catalog.permission
from iam_permission_catalog catalog
where catalog.permission <> all (array[
  'platform.read', 'tools:read', 'tools:write', 'profile.read', 'profile.write',
  'mail.read', 'mail.read:shared', 'mail.send', 'mail.write', 'mail.delete',
  'mail.admin', 'mail.external', 'mail.system',
  'drive.read', 'drive.read:shared', 'drive.write', 'drive.write:shared', 'drive.delete',
  'chat.read', 'chat.post', 'chat.create',
  'calendar.read', 'calendar.read:freebusy', 'calendar.write', 'calendar.manage',
  'calendar.write:respond', 'calendar.external',
  'meet.read', 'meet.write', 'notifications.read', 'notifications.write',
  'assistant.read', 'assistant.write', 'assistant.memory',
  'admin.helpdesk', 'admin.users', 'admin.groups', 'admin.domains', 'admin.security',
  'admin.retention', 'admin.config', 'admin.config.read', 'admin.config.write',
  'admin.audit', 'admin.plugins', 'admin.webhooks', 'admin.agents',
  'admin.console.read', 'admin.console.write', 'admin.services.read', 'admin.ai',
  'admin.search.write', 'admin.backups.restore',
  'admin.tenants.read', 'admin.tenants.export', 'admin.tenants.write', 'admin.tenants.delete',
  'admin.*', 'admin.config.*', 'admin.search.*',
  'caldav', 'carddav.read', 'carddav.write', 'webdav', 'smtp',
  'admin.drive', 'admin.chat'
]::text[]);

-- Roles that exist only to hold retired permissions.
create temporary table retired_iam_roles on commit drop as
select role.org_id, role.id, role.role_key
from iam_roles role
where exists (
    select 1 from iam_role_permissions held
    where held.org_id = role.org_id and held.role_id = role.id
  )
  and not exists (
    select 1 from iam_role_permissions held
    where held.org_id = role.org_id and held.role_id = role.id
      and held.permission not in (select permission from retired_iam_permissions)
  );

create temporary table retired_iam_bindings on commit drop as
with recursive retired as (
  select binding.org_id, binding.id
  from iam_role_bindings binding
  join retired_iam_roles role on role.org_id = binding.org_id and role.id = binding.role_id
  union
  select child.org_id, child.id
  from iam_role_bindings child
  join retired parent
    on parent.org_id = child.org_id and parent.id = child.parent_binding_id
)
select org_id, id from retired;

insert into iam_delegation_events (
  org_id, binding_id, event_type, actor_id, parent_binding_id, binding_snapshot
)
select binding.org_id, binding.id, 'revoked', null, binding.parent_binding_id,
       helix_iam_binding_snapshot(binding) || jsonb_build_object(
         'revokedAt', statement_timestamp(),
         'revocationReason', 'permission_retired',
         'retiredPermissions', coalesce((
           select jsonb_agg(held.permission order by held.permission)
           from iam_role_permissions held
           where held.org_id = binding.org_id and held.role_id = binding.role_id
             and held.permission in (select permission from retired_iam_permissions)
         ), '[]'::jsonb)
       )
from iam_role_bindings binding
join retired_iam_bindings retired
  on retired.org_id = binding.org_id and retired.id = binding.id
where binding.revoked_at is null;

-- Children first: parent_binding_id does not cascade.
do $$
declare
  removed integer;
  remaining integer;
begin
  loop
    delete from iam_role_bindings binding
    using retired_iam_bindings retired
    where binding.org_id = retired.org_id
      and binding.id = retired.id
      and not exists (
        select 1 from iam_role_bindings child
        where child.org_id = binding.org_id and child.parent_binding_id = binding.id
      );
    get diagnostics removed = row_count;
    select count(*) into remaining
    from iam_role_bindings binding
    join retired_iam_bindings retired
      on retired.org_id = binding.org_id and retired.id = binding.id;
    exit when remaining = 0;
    if removed = 0 then
      raise integrity_constraint_violation using
        message = 'retired IAM bindings form a delegation cycle';
    end if;
  end loop;
end
$$;

delete from iam_role_permissions
where permission in (select permission from retired_iam_permissions);
delete from iam_roles role
using retired_iam_roles retired
where role.org_id = retired.org_id and role.id = retired.id;
delete from iam_permission_catalog
where permission in (select permission from retired_iam_permissions);

-- Stored credential and grant scopes. A credential left with no scope is
-- revoked, because a credential must hold at least one scope.
update agent_credentials
set revoked_at = coalesce(revoked_at, statement_timestamp()),
    revocation_epoch = revocation_epoch + 1,
    updated_at = statement_timestamp()
where scopes <@ array(select permission from retired_iam_permissions);
update agent_credentials
set scopes = array(
      select scope from unnest(scopes) with ordinality as item(scope, position)
      where scope not in (select permission from retired_iam_permissions)
      order by position
    ),
    updated_at = statement_timestamp()
where scopes && array(select permission from retired_iam_permissions)
  and not scopes <@ array(select permission from retired_iam_permissions);

do $$
declare
  target text;
begin
  foreach target in array array[
    'actors', 'admin_oauth_apps', 'app_passwords', 'oauth_access_tokens',
    'oauth_authorization_codes', 'oauth_grants', 'oauth_refresh_tokens'
  ] loop
    execute format(
      'update public.%I set scopes = array(
         select scope from unnest(scopes) with ordinality as item(scope, position)
         where scope not in (select permission from retired_iam_permissions)
         order by position
       )
       where scopes && array(select permission from retired_iam_permissions)',
      target
    );
  end loop;
end
$$;

-- New orgs no longer receive billing_admin. Body otherwise matches 0116.
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
end
$$;
