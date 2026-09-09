create table if not exists drive_multipart_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  -- No object FK: the sweeper must still abort storage after object removal.
  object_id uuid not null,
  actor_id uuid references actors(id) on delete set null,
  storage_key text not null,
  upload_id text,
  status text not null default 'provisioning'
    check (status in ('provisioning', 'pending', 'completing', 'uploaded', 'completed', 'aborting')),
  byte_size integer not null check (byte_size > 0),
  part_size integer not null check (part_size > 0),
  part_count integer not null check (part_count > 0),
  expires_at timestamptz not null,
  next_attempt_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  completion_hash text,
  version_id uuid,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint drive_multipart_sessions_state_check check (
    (status in ('provisioning', 'pending', 'uploaded', 'completed') and lease_expires_at is null)
    or (status in ('completing', 'aborting') and lease_expires_at is not null)
  )
);

create unique index if not exists drive_multipart_sessions_org_object_idx
  on drive_multipart_sessions (org_id, object_id);

create unique index if not exists drive_multipart_sessions_org_upload_idx
  on drive_multipart_sessions (org_id, upload_id)
  where upload_id is not null;

create index if not exists drive_multipart_sessions_sweep_idx
  on drive_multipart_sessions (next_attempt_at, expires_at, created_at)
  where status in ('provisioning', 'pending', 'completing', 'uploaded', 'aborting');

alter table drive_multipart_sessions enable row level security;
alter table drive_multipart_sessions force row level security;
drop policy if exists helix_tenant_isolation on drive_multipart_sessions;
create policy helix_tenant_isolation on drive_multipart_sessions
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
