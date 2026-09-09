-- A scanner verdict and these cleanup jobs commit before any rejected bytes
-- are removed from object storage.
create table if not exists drive_quarantine_deletions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  -- Deliberately no object FK: cleanup must survive hard object deletion.
  object_id uuid not null,
  actor_id uuid references actors(id) on delete set null,
  storage_key text not null,
  status text not null default 'pending' check (status in ('pending', 'processing')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint drive_quarantine_deletions_state_check check (
    (status = 'pending' and lease_expires_at is null)
    or (status = 'processing' and lease_expires_at is not null)
  )
);

create unique index if not exists drive_quarantine_deletions_org_key_idx
  on drive_quarantine_deletions (org_id, storage_key);

create index if not exists drive_quarantine_deletions_claim_idx
  on drive_quarantine_deletions (next_attempt_at, created_at)
  where status = 'pending';

alter table drive_quarantine_deletions enable row level security;
alter table drive_quarantine_deletions force row level security;
drop policy if exists helix_tenant_isolation on drive_quarantine_deletions;
create policy helix_tenant_isolation on drive_quarantine_deletions
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
