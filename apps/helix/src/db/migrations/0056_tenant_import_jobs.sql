create table if not exists tenant_import_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  status text not null check (status in ('succeeded', 'failed')),
  dry_run boolean not null default true check (dry_run),
  requested_by_actor_id uuid references actors(id),
  archive_byte_size bigint not null check (archive_byte_size > 0),
  archive_sha256 text not null check (archive_sha256 ~ '^[a-f0-9]{64}$'),
  has_conflict_policy_input boolean not null default false,
  conflict_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(conflict_policy) = 'object'),
  ok boolean not null,
  source_org_id uuid,
  source_slug text,
  source_generated_at timestamp with time zone,
  object_bytes_mode text check (object_bytes_mode in ('included', 'metadata_only')),
  issue_count integer not null default 0 check (issue_count >= 0),
  operation_count integer not null default 0 check (operation_count >= 0),
  conflict_count integer not null default 0 check (conflict_count >= 0),
  remap_count integer not null default 0 check (remap_count >= 0),
  error_code text,
  error_message text,
  result_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(result_summary) = 'object'),
  completed_at timestamp with time zone not null default now(),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists tenant_import_jobs_org_idx
  on tenant_import_jobs(org_id, created_at desc, id desc);

create index if not exists tenant_import_jobs_status_idx
  on tenant_import_jobs(org_id, status, created_at desc, id desc);
