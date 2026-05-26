create table if not exists tenant_export_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  status text not null default 'queued' check (
    status in ('queued', 'running', 'succeeded', 'failed')
  ),
  include_object_bytes boolean not null default true,
  presigned_url_expires_seconds integer not null default 86400 check (
    presigned_url_expires_seconds between 1 and 604800
  ),
  requested_by_actor_id uuid references actors(id),
  storage_key text,
  filename text,
  content_type text,
  byte_size bigint,
  last_error text,
  attempt_count integer not null default 0,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists tenant_export_jobs_org_idx
  on tenant_export_jobs(org_id, created_at desc, id desc);

create index if not exists tenant_export_jobs_claim_idx
  on tenant_export_jobs(status, updated_at)
  where status in ('queued', 'failed');
