create table if not exists drive_preview_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  object_id uuid not null references objects(id) on delete cascade,
  version_id uuid not null references drive_versions(id) on delete cascade,
  actor_id uuid references actors(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'processing')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint drive_preview_jobs_state_check check (
    (status = 'pending' and lease_expires_at is null)
    or (status = 'processing' and lease_expires_at is not null)
  ),
  constraint drive_preview_jobs_org_version_key unique (org_id, version_id)
);

create index if not exists drive_preview_jobs_claim_idx
  on drive_preview_jobs (next_attempt_at, created_at)
  where status = 'pending';

alter table drive_preview_jobs enable row level security;
alter table drive_preview_jobs force row level security;
drop policy if exists helix_tenant_isolation on drive_preview_jobs;
create policy helix_tenant_isolation on drive_preview_jobs
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
