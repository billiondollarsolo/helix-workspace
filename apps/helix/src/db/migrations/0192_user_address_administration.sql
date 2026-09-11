-- User administrators manage directory addresses without receiving mailbox-content access.
-- Reuse the canonical live role snapshot and the API's exact permission/deny semantics.
create function helix_user_address_admin_access(tenant_id uuid, writable boolean)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with principal as (
    select actor.scopes, actor.type,
      public.helix_actor_role_bindings(actor.org_id, actor.id) as bindings
    from public.actors actor
    where actor.org_id = tenant_id and tenant_id = public.helix_current_org_id()
      and actor.id = public.helix_current_actor_id()
      and public.helix_credential_principal_is_active(actor.id, actor.org_id)
  ), org_bindings as (
    select binding from principal, jsonb_array_elements(principal.bindings) binding
    where binding->>'scopeType' = 'org'
  ), permissions(permission) as (
    values ('admin.users'), ('admin.console.write')
    union all select 'admin.console.read' where not writable
  )
  select exists (
    select 1 from principal
    where not exists (select 1 from org_bindings where binding->'deny' ? 'admin.users')
      and exists (
        select 1 from permissions
        where not exists (select 1 from org_bindings where binding->'deny' ? permissions.permission)
          and (
            principal.type = 'system'
            or principal.scopes && array[permissions.permission, 'admin.*', '*']
            or exists (select 1 from org_bindings where binding->'allow' ? permissions.permission)
          )
      )
  )
$$;

alter function helix_user_address_admin_access(uuid, boolean) owner to helix_migration_owner;
revoke all on function helix_user_address_admin_access(uuid, boolean) from public;
grant execute on function helix_user_address_admin_access(uuid, boolean) to helix_app, helix_worker, helix_readonly;

create policy helix_user_address_admin_read on mail_aliases for select
  using (org_id = helix_current_org_id() and helix_user_address_admin_access(org_id, false));
create policy helix_user_address_admin_create on mail_aliases for insert
  with check (org_id = helix_current_org_id() and helix_user_address_admin_access(org_id, true));
create policy helix_user_address_admin_update on mail_aliases for update
  using (org_id = helix_current_org_id() and helix_user_address_admin_access(org_id, true))
  with check (org_id = helix_current_org_id() and helix_user_address_admin_access(org_id, true));
