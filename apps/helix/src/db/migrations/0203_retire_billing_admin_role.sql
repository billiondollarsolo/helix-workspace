-- Retire the billing_admin role and the admin.billing permission (ADR-0030).
-- Helix has no billing, so neither grants anything. The application no longer
-- knows the permission, and persisted permission sets that contain an unknown
-- entry fail closed as a unit, so every stored copy is removed here.
--
-- The IAM model stays append-only where it promises to be:
--   * roles and role permissions are never updated; retired rows are deleted,
--     which their update-only guards allow;
--   * bindings are never edited. Each active binding to a retired role, and
--     every binding delegated beneath one, is recorded as revoked in the
--     append-only iam_delegation_events log before it is removed;
--   * iam_delegation_events itself is untouched apart from those appends.

create temporary table retired_billing_bindings on commit drop as
with recursive retired as (
  select binding.org_id, binding.id
  from iam_role_bindings binding
  join iam_roles role on role.org_id = binding.org_id and role.id = binding.role_id
  where role.kind = 'built_in' and role.role_key = 'billing_admin'
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
         'retiredPermission', 'admin.billing'
       )
from iam_role_bindings binding
join retired_billing_bindings retired
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
    using retired_billing_bindings retired
    where binding.org_id = retired.org_id
      and binding.id = retired.id
      and not exists (
        select 1 from iam_role_bindings child
        where child.org_id = binding.org_id and child.parent_binding_id = binding.id
      );
    get diagnostics removed = row_count;
    select count(*) into remaining
    from iam_role_bindings binding
    join retired_billing_bindings retired
      on retired.org_id = binding.org_id and retired.id = binding.id;
    exit when remaining = 0;
    if removed = 0 then
      raise integrity_constraint_violation using
        message = 'retired billing bindings form a delegation cycle';
    end if;
  end loop;
end
$$;

delete from iam_role_permissions where permission = 'admin.billing';
delete from iam_roles where kind = 'built_in' and role_key = 'billing_admin';
delete from iam_permission_catalog where permission = 'admin.billing';

-- Stored credential and grant scopes. A credential whose only scope was the
-- retired permission is revoked, because a credential must hold one scope.
update agent_credentials
set revoked_at = coalesce(revoked_at, statement_timestamp()),
    revocation_epoch = revocation_epoch + 1,
    updated_at = statement_timestamp()
where scopes = array['admin.billing']::text[];
update agent_credentials
set scopes = array_remove(scopes, 'admin.billing'), updated_at = statement_timestamp()
where 'admin.billing' = any(scopes) and cardinality(scopes) > 1;

update actors set scopes = array_remove(scopes, 'admin.billing')
where 'admin.billing' = any(scopes);
update admin_oauth_apps set scopes = array_remove(scopes, 'admin.billing')
where 'admin.billing' = any(scopes);
update app_passwords set scopes = array_remove(scopes, 'admin.billing')
where 'admin.billing' = any(scopes);
update oauth_access_tokens set scopes = array_remove(scopes, 'admin.billing')
where 'admin.billing' = any(scopes);
update oauth_authorization_codes set scopes = array_remove(scopes, 'admin.billing')
where 'admin.billing' = any(scopes);
update oauth_grants set scopes = array_remove(scopes, 'admin.billing')
where 'admin.billing' = any(scopes);
update oauth_refresh_tokens set scopes = array_remove(scopes, 'admin.billing')
where 'admin.billing' = any(scopes);

-- New orgs no longer receive the role. Body otherwise matches 0116.
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
