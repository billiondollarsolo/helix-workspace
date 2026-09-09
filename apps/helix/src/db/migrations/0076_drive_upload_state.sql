do $$ begin
  create type drive_upload_state as enum (
    'pending_upload',
    'uploaded',
    'scanning',
    'active',
    'quarantined',
    'scan_failed',
    'trashed'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type drive_scan_job_status as enum (
    'pending',
    'running',
    'retry_scheduled',
    'completed',
    'failed',
    'cancelled'
  );
exception when duplicate_object then null; end $$;

alter table objects
  add column if not exists upload_state drive_upload_state not null default 'active',
  add column if not exists upload_declared_byte_size bigint,
  add column if not exists upload_declared_sha256 text;

update objects
set upload_state = case
  when deleted_at is not null then 'trashed'::drive_upload_state
  when metadata->>'status' = 'pending_upload' then 'pending_upload'::drive_upload_state
  when metadata->>'status' in ('infected', 'quarantined') then 'quarantined'::drive_upload_state
  when metadata->>'status' = 'scan_failed' then 'scan_failed'::drive_upload_state
  else 'active'::drive_upload_state
end;

create index if not exists objects_org_upload_state_idx
  on objects (org_id, upload_state, updated_at);

create table if not exists drive_scan_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  object_id uuid not null references objects(id) on delete cascade,
  version_id uuid not null references drive_versions(id) on delete cascade,
  requested_by_actor_id uuid references actors(id),
  status drive_scan_job_status not null default 'pending',
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  scan_evidence jsonb not null default '{}',
  last_error_code text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint drive_scan_jobs_attempts_check check (
    attempts >= 0 and max_attempts between 1 and 20 and attempts <= max_attempts
  ),
  constraint drive_scan_jobs_version_unique unique (version_id)
);

create index if not exists drive_scan_jobs_claim_idx
  on drive_scan_jobs (available_at, created_at)
  where status in ('pending', 'retry_scheduled', 'running');
create index if not exists drive_scan_jobs_org_object_idx
  on drive_scan_jobs (org_id, object_id, created_at desc);

alter table drive_scan_jobs enable row level security;
drop policy if exists helix_tenant_isolation on drive_scan_jobs;
create policy helix_tenant_isolation on drive_scan_jobs
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

create or replace function helix_require_active_message_attachment()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
    from objects o
    join messages m on m.id = new.message_id
    where o.id = new.object_id
      and o.org_id = m.org_id
      and o.upload_state = 'active'
      and o.deleted_at is null
  ) then
    raise exception 'message attachments require an active Drive object'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists message_attachments_require_active_object on message_attachments;
create trigger message_attachments_require_active_object
before insert or update of object_id on message_attachments
for each row execute function helix_require_active_message_attachment();
