create index if not exists tenant_storage_migration_jobs_live_write_gate_idx
  on tenant_storage_migration_jobs(org_id, updated_at desc, created_at desc, id desc)
  where dry_run = false
    and status in ('queued', 'running', 'failed', 'succeeded')
    and source_storage is not null
    and target_storage is not null;
