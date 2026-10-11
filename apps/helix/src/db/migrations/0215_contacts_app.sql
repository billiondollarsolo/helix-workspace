-- The Contacts app. Contacts stay vCards in the member's default CardDAV
-- address book and labels stay vCard CATEGORIES, so CardDAV clients see every
-- change. carddav_contact_labels only remembers labels that have no contacts.
--
-- contacts.read / contacts.write are new catalog permissions. Every active
-- person holds them through the built-in `workspace_member` role (0208), next
-- to profile.read / profile.write; the role is re-seeded in every org below.
-- Like 0208, nothing rewrites actors.scopes, so no session is revoked. The IAM
-- model stays append-only: role and permission rows are only inserted.

insert into iam_permission_catalog (permission, catalog_version) values
  ('contacts.read', 2),
  ('contacts.write', 2)
on conflict (permission) do nothing;

-- Body matches 0208 plus the member's contacts permissions.
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
    (input_org_id, built_in_role_id, 'profile.write', 'allow'),
    (input_org_id, built_in_role_id, 'contacts.read', 'allow'),
    (input_org_id, built_in_role_id, 'contacts.write', 'allow')
  on conflict do nothing;
end
$$;

select helix_ensure_builtin_iam_roles(id) from orgs;

create table carddav_contact_labels (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  owner_actor_id uuid not null,
  name text not null check (
    char_length(btrim(name)) between 1 and 80 and name !~ '[\r\n,;\\]'
  ),
  created_at timestamptz not null default statement_timestamp(),
  foreign key (org_id, owner_actor_id) references actors (org_id, id) on delete cascade
);

create unique index carddav_contact_labels_owner_name_idx
  on carddav_contact_labels (org_id, owner_actor_id, lower(name));

alter table carddav_contact_labels enable row level security;
alter table carddav_contact_labels force row level security;
create policy helix_tenant_isolation on carddav_contact_labels
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
create policy helix_tenant_boundary on carddav_contact_labels as restrictive for all
  using (org_id = public.helix_current_org_id())
  with check (org_id = public.helix_current_org_id());
