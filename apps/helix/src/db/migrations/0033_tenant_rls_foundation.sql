create or replace function helix_current_org_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('helix.org_id', true), '')::uuid
$$;

do $$
declare
  tenant_table regclass;
begin
  for tenant_table in
    select c.oid::regclass
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public'
      and c.relkind = 'r'
      and a.attname = 'org_id'
      and not a.attisdropped
  loop
    execute format('alter table %s enable row level security', tenant_table);
    execute format('drop policy if exists helix_tenant_isolation on %s', tenant_table);
    execute format(
      'create policy helix_tenant_isolation on %s using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id())',
      tenant_table
    );
  end loop;
end
$$;
