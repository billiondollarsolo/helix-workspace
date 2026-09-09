create table backup_restore_jobs (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  requested_by_actor_id uuid not null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 128),
  backup_id text not null check (backup_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  encrypted boolean not null default false,
  target_database text not null unique
    check (target_database ~ '^helix_restore_[a-z0-9_]{1,49}$'),
  target_object_bucket text not null unique
    check (target_object_bucket ~ '^helix-restore-[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'),
  status text not null default 'pending_approval'
    check (status in ('pending_approval', 'queued', 'processing', 'completed', 'cancelled', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz,
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  cancel_requested_at timestamptz,
  last_error text,
  result jsonb,
  completed_at timestamptz,
  cancelled_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, requested_by_actor_id) references actors(org_id, id),
  unique (org_id, requested_by_actor_id, idempotency_key),
  constraint backup_restore_job_lease_state check (
    (status = 'pending_approval' and next_attempt_at is null and lease_owner is null
      and lease_token is null and lease_expires_at is null)
    or (status = 'queued' and next_attempt_at is not null and lease_owner is null
      and lease_token is null and lease_expires_at is null)
    or (status = 'processing' and next_attempt_at is null and lease_owner is not null
      and lease_token is not null and lease_expires_at is not null)
    or (status in ('completed', 'cancelled', 'failed') and next_attempt_at is null
      and lease_owner is null and lease_token is null and lease_expires_at is null)
  )
);

create index backup_restore_jobs_due_idx
  on backup_restore_jobs (coalesce(next_attempt_at, lease_expires_at), created_at, id)
  where status in ('queued', 'processing');

create table backup_restore_job_approvals (
  job_id uuid not null references backup_restore_jobs(id) on delete cascade,
  org_id uuid not null references orgs(id),
  actor_id uuid not null,
  approved_at timestamptz not null default now(),
  primary key (job_id, actor_id),
  foreign key (org_id, actor_id) references actors(org_id, id)
);

create function helix_approve_backup_restore_job(
  input_id uuid, input_org_id uuid, input_actor_id uuid
) returns setof backup_restore_jobs language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
declare job backup_restore_jobs;
begin
  select * into job from backup_restore_jobs
  where id = input_id and org_id = input_org_id for update;
  if not found or job.status <> 'pending_approval' then return; end if;
  if job.requested_by_actor_id = input_actor_id then
    raise exception 'Restore requester cannot approve their own job' using errcode = '42501';
  end if;
  insert into backup_restore_job_approvals (job_id, org_id, actor_id)
    values (job.id, job.org_id, input_actor_id) on conflict do nothing;
  if (select count(*) from backup_restore_job_approvals where job_id = job.id) >= 2 then
    update backup_restore_jobs set status = 'queued', next_attempt_at = statement_timestamp(),
      updated_at = statement_timestamp() where id = job.id returning * into job;
  end if;
  return next job;
end $$;

create function helix_cancel_backup_restore_job(input_id uuid, input_org_id uuid)
returns setof backup_restore_jobs language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
begin
  return query update backup_restore_jobs
  set status = case when status in ('pending_approval', 'queued') then 'cancelled' else status end,
      cancelled_at = case when status in ('pending_approval', 'queued') then statement_timestamp() else cancelled_at end,
      cancel_requested_at = case when status = 'processing' then statement_timestamp() else cancel_requested_at end,
      next_attempt_at = case when status in ('pending_approval', 'queued') then null else next_attempt_at end,
      updated_at = statement_timestamp()
  where id = input_id and org_id = input_org_id
    and status in ('pending_approval', 'queued', 'processing') returning *;
end $$;

create function helix_claim_backup_restore_jobs(
  input_owner text, input_limit integer, input_lease_seconds integer
) returns setof backup_restore_jobs language sql volatile security definer
set search_path = pg_catalog, public as $$
  with due as (
    select id from backup_restore_jobs
    where (status = 'queued' and next_attempt_at <= statement_timestamp())
       or (status = 'processing' and lease_expires_at <= statement_timestamp()
           and cancel_requested_at is null)
    order by coalesce(next_attempt_at, lease_expires_at), created_at, id
    limit greatest(0, least(coalesce(input_limit, 0), 10))
    for update skip locked
  )
  update backup_restore_jobs job
  set status = 'processing', attempt_count = attempt_count + 1, next_attempt_at = null,
      lease_owner = left(coalesce(input_owner, 'backup-restore-worker'), 200),
      lease_token = gen_random_uuid(),
      lease_expires_at = statement_timestamp()
        + make_interval(secs => greatest(1, least(coalesce(input_lease_seconds, 1200), 3600))),
      updated_at = statement_timestamp()
  from due where job.id = due.id returning job.*
$$;

create function helix_backup_restore_cancel_requested(input_id uuid, input_lease_token uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select exists(select 1 from backup_restore_jobs
    where id = input_id and status = 'processing' and lease_token = input_lease_token
      and cancel_requested_at is not null)
$$;

create function helix_complete_backup_restore_job(
  input_id uuid, input_lease_token uuid, input_result jsonb
) returns boolean language sql volatile security definer set search_path = pg_catalog, public as $$
  with changed as (
    update backup_restore_jobs set status = 'completed', result = input_result,
      completed_at = statement_timestamp(), lease_owner = null, lease_token = null,
      lease_expires_at = null, updated_at = statement_timestamp()
    where id = input_id and status = 'processing' and lease_token = input_lease_token
      and cancel_requested_at is null returning 1
  ) select exists(select 1 from changed)
$$;

create function helix_fail_backup_restore_job(
  input_id uuid, input_lease_token uuid, input_error text
) returns boolean language sql volatile security definer set search_path = pg_catalog, public as $$
  with changed as (
    update backup_restore_jobs set status = 'failed', last_error = left(input_error, 4000),
      failed_at = statement_timestamp(), lease_owner = null, lease_token = null,
      lease_expires_at = null, updated_at = statement_timestamp()
    where id = input_id and status = 'processing' and lease_token = input_lease_token returning 1
  ) select exists(select 1 from changed)
$$;

create function helix_mark_backup_restore_job_cancelled(input_id uuid, input_lease_token uuid)
returns boolean language sql volatile security definer set search_path = pg_catalog, public as $$
  with changed as (
    update backup_restore_jobs set status = 'cancelled', cancelled_at = statement_timestamp(),
      lease_owner = null, lease_token = null, lease_expires_at = null, updated_at = statement_timestamp()
    where id = input_id and status = 'processing' and lease_token = input_lease_token
      and cancel_requested_at is not null returning 1
  ) select exists(select 1 from changed)
$$;

alter table backup_restore_jobs enable row level security;
alter table backup_restore_jobs force row level security;
create policy helix_tenant_isolation on backup_restore_jobs
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());
alter table backup_restore_job_approvals enable row level security;
alter table backup_restore_job_approvals force row level security;
create policy helix_tenant_isolation on backup_restore_job_approvals
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());

revoke all on backup_restore_jobs, backup_restore_job_approvals from public, helix_readonly;
grant select, insert on backup_restore_jobs to helix_app, helix_worker;
grant select on backup_restore_job_approvals to helix_app, helix_worker;
revoke execute on function helix_approve_backup_restore_job(uuid, uuid, uuid),
  helix_cancel_backup_restore_job(uuid, uuid),
  helix_claim_backup_restore_jobs(text, integer, integer),
  helix_backup_restore_cancel_requested(uuid, uuid),
  helix_complete_backup_restore_job(uuid, uuid, jsonb),
  helix_fail_backup_restore_job(uuid, uuid, text),
  helix_mark_backup_restore_job_cancelled(uuid, uuid) from public;
grant execute on function helix_approve_backup_restore_job(uuid, uuid, uuid),
  helix_cancel_backup_restore_job(uuid, uuid),
  helix_claim_backup_restore_jobs(text, integer, integer),
  helix_backup_restore_cancel_requested(uuid, uuid),
  helix_complete_backup_restore_job(uuid, uuid, jsonb),
  helix_fail_backup_restore_job(uuid, uuid, text),
  helix_mark_backup_restore_job_cancelled(uuid, uuid) to helix_app, helix_worker;
