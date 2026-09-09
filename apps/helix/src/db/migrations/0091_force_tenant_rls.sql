create or replace function helix_current_actor_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('helix.actor_id', true), '')::uuid
$$;

-- Repair every existing tenant table in one place. The schema gate rejects
-- later org_id tables unless their own migration installs this same contract.
do $$
declare
  tenant_table record;
  tenant_policy record;
begin
  for tenant_table in
    select n.nspname, c.relname, c.oid
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and a.attname = 'org_id'
      and not a.attisdropped
  loop
    execute format(
      'alter table %I.%I enable row level security',
      tenant_table.nspname,
      tenant_table.relname
    );
    execute format(
      'alter table %I.%I force row level security',
      tenant_table.nspname,
      tenant_table.relname
    );
    for tenant_policy in select polname from pg_policy where polrelid = tenant_table.oid
    loop
      execute format(
        'drop policy %I on %I.%I',
        tenant_policy.polname,
        tenant_table.nspname,
        tenant_table.relname
      );
    end loop;
    execute format(
      'create policy helix_tenant_isolation on %I.%I using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id())',
      tenant_table.nspname,
      tenant_table.relname
    );
  end loop;
end
$$;

-- Tenant routing has to resolve an exact verified hostname before the request
-- tenant GUC exists. Expose only that lookup, never a cross-tenant table read.
create or replace function helix_verified_tenant_domain(hostname text)
returns setof public.admin_domains
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select domain.*
  from public.admin_domains domain
  where domain.domain = hostname
    and domain.verification_status = 'verified'
  limit 1
$$;

alter function helix_verified_tenant_domain(text) owner to helix_migration_owner;
revoke all on function helix_verified_tenant_domain(text) from public;
grant execute on function helix_verified_tenant_domain(text) to helix_app;
