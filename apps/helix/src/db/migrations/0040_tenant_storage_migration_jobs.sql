create table if not exists tenant_storage_migration_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  target text not null check (target in ('byo', 'helix-default')),
  status text not null default 'queued' check (
    status in ('queued', 'running', 'succeeded', 'succeeded_with_errors', 'failed', 'dry_run')
  ),
  dry_run boolean not null default false,
  requested_by_actor_id uuid references actors(id),
  planned_count integer not null default 0,
  copied_count integer not null default 0,
  verified_count integer not null default 0,
  failures jsonb not null default '[]'::jsonb,
  last_error text,
  attempt_count integer not null default 0,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists tenant_storage_migration_jobs_org_idx
  on tenant_storage_migration_jobs(org_id, created_at desc);

create index if not exists tenant_storage_migration_jobs_claim_idx
  on tenant_storage_migration_jobs(status, updated_at)
  where status in ('queued', 'failed');
