-- Durable retry/dead-letter state for Drive antivirus outages. Uploaded bytes
-- remain non-ready and therefore unreadable until a clean verdict commits.
create table if not exists drive_scan_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  object_id uuid not null references objects(id) on delete cascade,
  actor_id uuid references actors(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'dead_lettered')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz default now(),
  lease_expires_at timestamptz,
  last_error text,
  finalize_metadata jsonb not null default '{}'::jsonb,
  override_count integer not null default 0 check (override_count >= 0),
  last_override_reason text,
  last_overridden_by_actor_id uuid references actors(id) on delete set null,
  last_overridden_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint drive_scan_jobs_state_check check (
    (status = 'pending' and next_attempt_at is not null and lease_expires_at is null)
    or (status = 'processing' and lease_expires_at is not null)
    or (status = 'dead_lettered' and next_attempt_at is null and lease_expires_at is null)
  )
);

create unique index if not exists drive_scan_jobs_org_object_idx
  on drive_scan_jobs (org_id, object_id);

create index if not exists drive_scan_jobs_claim_idx
  on drive_scan_jobs (next_attempt_at, created_at)
  where status = 'pending';

alter table drive_scan_jobs enable row level security;
drop policy if exists helix_tenant_isolation on drive_scan_jobs;
create policy helix_tenant_isolation on drive_scan_jobs
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
