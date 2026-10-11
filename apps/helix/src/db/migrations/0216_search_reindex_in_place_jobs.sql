-- Admin search reindex (`POST /api/admin/search/reindex`, `helix reindex --all`)
-- becomes a durable job instead of a request that outlived HTTP timeouts. It
-- reuses search_reindex_jobs and its lease, retry, and cancel functions:
--
--   shadow   rebuilds every organization into a new index and swaps it in (0145);
--   in_place reindexes one organization into the live index, optionally pruning
--            stale entries, reporting progress as it goes.
--
-- At most one in-place job per organization is queued or running at a time, so a
-- retried request joins the running job instead of starting another.

alter table search_reindex_jobs
  add column mode text not null default 'shadow' check (mode in ('shadow', 'in_place')),
  add column prune_stale boolean not null default false,
  add column deleted_documents bigint not null default 0 check (deleted_documents >= 0),
  add column counts jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object'),
  alter column shadow_index_uid drop not null;

alter table search_reindex_jobs
  add constraint search_reindex_job_mode_shape check (
    (mode = 'shadow' and shadow_index_uid is not null and target_org_id is null)
    or (mode = 'in_place' and shadow_index_uid is null and target_org_id = org_id)
  );

create unique index search_reindex_jobs_one_in_place_per_org
  on search_reindex_jobs (target_org_id)
  where mode = 'in_place' and status in ('queued', 'processing');

create or replace function helix_active_search_shadow_indexes()
returns table (shadow_index_uid text) language sql stable security definer
set search_path = pg_catalog, public as $$
  select job.shadow_index_uid from search_reindex_jobs job
  where job.mode = 'shadow' and job.status in ('queued', 'processing')
  order by job.created_at, job.id
$$;

-- Each worker claims only its own kind of job.
drop function helix_claim_search_reindex_jobs(text, integer, integer);

create function helix_claim_search_reindex_jobs(
  input_owner text, input_mode text, input_limit integer, input_lease_seconds integer
) returns setof search_reindex_jobs language sql volatile security definer
set search_path = pg_catalog, public as $$
  with due as (
    select id from search_reindex_jobs
    where mode = input_mode
      and ((status = 'queued' and next_attempt_at <= statement_timestamp())
        or (status = 'processing' and lease_expires_at <= statement_timestamp()))
    order by created_at, id limit greatest(0, least(coalesce(input_limit, 0), 10))
    for update skip locked
  )
  update search_reindex_jobs job
  set status = 'processing', attempt_count = attempt_count + 1, next_attempt_at = null,
      lease_owner = left(coalesce(input_owner, 'search-reindex'), 200), lease_token = gen_random_uuid(),
      lease_expires_at = statement_timestamp() + make_interval(secs => greatest(1, least(coalesce(input_lease_seconds, 300), 3600))),
      updated_at = statement_timestamp()
  from due where job.id = due.id returning job.*
$$;

-- Progress of a running in-place job; it also renews the lease, so a long run is
-- not claimed again while it is still reporting. False once the job was
-- cancelled or its lease lost, which tells the worker to stop.
create function helix_progress_search_reindex_job(
  input_id uuid, input_lease_token uuid, input_source_index integer,
  input_total_documents bigint, input_deleted_documents bigint, input_counts jsonb,
  input_lease_seconds integer
) returns boolean language sql volatile security definer
set search_path = pg_catalog, public as $$
  with saved as (
    update search_reindex_jobs set
      source_index = greatest(0, input_source_index),
      total_documents = greatest(0, input_total_documents),
      deleted_documents = greatest(0, input_deleted_documents),
      counts = case when jsonb_typeof(input_counts) = 'object' then input_counts else counts end,
      lease_expires_at = statement_timestamp() + make_interval(secs => greatest(1, least(coalesce(input_lease_seconds, 300), 3600))),
      updated_at = statement_timestamp()
    where id = input_id and mode = 'in_place' and status = 'processing'
      and lease_token = input_lease_token
    returning 1
  ) select exists(select 1 from saved)
$$;

revoke execute on function helix_claim_search_reindex_jobs(text, text, integer, integer),
  helix_progress_search_reindex_job(uuid, uuid, integer, bigint, bigint, jsonb, integer)
  from public;
grant execute on function helix_claim_search_reindex_jobs(text, text, integer, integer),
  helix_progress_search_reindex_job(uuid, uuid, integer, bigint, bigint, jsonb, integer)
  to helix_app, helix_worker;
