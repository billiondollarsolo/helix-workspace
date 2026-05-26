alter table tenant_storage_migration_jobs
  add column if not exists source_storage jsonb,
  add column if not exists target_storage jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tenant_storage_migration_jobs_source_storage_object_chk'
  ) then
    alter table tenant_storage_migration_jobs
      add constraint tenant_storage_migration_jobs_source_storage_object_chk
      check (source_storage is null or jsonb_typeof(source_storage) = 'object');
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'tenant_storage_migration_jobs_target_storage_object_chk'
  ) then
    alter table tenant_storage_migration_jobs
      add constraint tenant_storage_migration_jobs_target_storage_object_chk
      check (target_storage is null or jsonb_typeof(target_storage) = 'object');
  end if;
end $$;
