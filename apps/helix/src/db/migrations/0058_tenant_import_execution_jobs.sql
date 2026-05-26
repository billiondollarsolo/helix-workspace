do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select c.conname
    from pg_constraint c
    join pg_attribute a
      on a.attrelid = c.conrelid
      and a.attnum = any(c.conkey)
    where c.conrelid = 'tenant_import_jobs'::regclass
      and c.contype = 'c'
      and a.attname = 'status'
  loop
    execute format('alter table tenant_import_jobs drop constraint %I', constraint_name);
  end loop;

  for constraint_name in
    select c.conname
    from pg_constraint c
    join pg_attribute a
      on a.attrelid = c.conrelid
      and a.attnum = any(c.conkey)
    where c.conrelid = 'tenant_import_jobs'::regclass
      and c.contype = 'c'
      and a.attname = 'dry_run'
      and pg_get_constraintdef(c.oid) = 'CHECK (dry_run)'
  loop
    execute format('alter table tenant_import_jobs drop constraint %I', constraint_name);
  end loop;
end $$;

alter table tenant_import_jobs
  add constraint tenant_import_jobs_status_check
  check (status in ('succeeded', 'failed', 'blocked'));
