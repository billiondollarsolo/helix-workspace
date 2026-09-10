-- Granular per-command/actor policies remain authoritative. A restrictive
-- policy ANDs the tenant boundary with every permissive policy, including ones
-- introduced by future migrations; it never grants access by itself.
do $migration$
declare
  tenant_table record;
begin
  for tenant_table in
    select relation.relname
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_attribute column_row on column_row.attrelid = relation.oid
    where namespace.nspname = 'public' and relation.relkind in ('r', 'p')
      and column_row.attname = 'org_id' and not column_row.attisdropped
  loop
    execute format('alter table public.%I enable row level security', tenant_table.relname);
    execute format('alter table public.%I force row level security', tenant_table.relname);
    execute format('drop policy if exists helix_tenant_boundary on public.%I', tenant_table.relname);
    execute format(
      'create policy helix_tenant_boundary on public.%I as restrictive for all
       using (org_id = public.helix_current_org_id())
       with check (org_id = public.helix_current_org_id())',
      tenant_table.relname
    );
  end loop;
end
$migration$;
