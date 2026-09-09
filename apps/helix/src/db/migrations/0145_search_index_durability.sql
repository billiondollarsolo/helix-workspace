create table search_index_mutations (
  id bigint generated always as identity primary key,
  org_id uuid not null references orgs(id),
  indexer_id text not null,
  mutation jsonb not null check (jsonb_typeof(mutation) = 'object'),
  source_occurred_at timestamptz not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'dead_lettered')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz,
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  completed_at timestamptz,
  dead_lettered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint search_index_mutation_lease_state check (
    (status = 'queued' and next_attempt_at is not null and lease_owner is null
      and lease_token is null and lease_expires_at is null)
    or (status = 'processing' and next_attempt_at is null and lease_owner is not null
      and lease_token is not null and lease_expires_at is not null)
    or (status in ('completed', 'dead_lettered') and next_attempt_at is null
      and lease_owner is null and lease_token is null and lease_expires_at is null)
  )
);

create index search_index_mutations_due_idx
  on search_index_mutations (coalesce(next_attempt_at, lease_expires_at), id)
  where status in ('queued', 'processing');

create table search_index_checkpoints (
  consumer text primary key,
  last_mutation_id bigint not null default 0 check (last_mutation_id >= 0),
  updated_at timestamptz not null default now()
);
insert into search_index_checkpoints (consumer) values ('live');

create table search_reindex_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  requested_by_actor_id uuid not null,
  target_org_id uuid references orgs(id),
  types text[] not null,
  batch_size integer not null check (batch_size between 1 and 1000),
  shadow_index_uid text not null unique,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'cancelled', 'dead_lettered')),
  phase text not null default 'backfill' check (phase in ('backfill', 'replay', 'swap')),
  source_index integer not null default 0 check (source_index >= 0),
  source_cursor jsonb,
  start_mutation_id bigint not null default 0 check (start_mutation_id >= 0),
  replay_mutation_id bigint not null default 0 check (replay_mutation_id >= 0),
  total_documents bigint not null default 0 check (total_documents >= 0),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz,
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  completed_at timestamptz,
  cancelled_at timestamptz,
  dead_lettered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, requested_by_actor_id) references actors(org_id, id),
  constraint search_reindex_job_lease_state check (
    (status = 'queued' and next_attempt_at is not null and lease_owner is null
      and lease_token is null and lease_expires_at is null)
    or (status = 'processing' and next_attempt_at is null and lease_owner is not null
      and lease_token is not null and lease_expires_at is not null)
    or (status in ('completed', 'cancelled', 'dead_lettered') and next_attempt_at is null
      and lease_owner is null and lease_token is null and lease_expires_at is null)
  )
);

create index search_reindex_jobs_due_idx
  on search_reindex_jobs (coalesce(next_attempt_at, lease_expires_at), created_at, id)
  where status in ('queued', 'processing');

create function helix_enqueue_search_index_mutation(
  input_org_id uuid, input_indexer_id text, input_mutation jsonb, input_occurred_at timestamptz
) returns bigint language sql volatile security definer
set search_path = pg_catalog, public as $$
  insert into search_index_mutations (
    org_id, indexer_id, mutation, source_occurred_at, next_attempt_at
  ) values (
    input_org_id, left(input_indexer_id, 200), input_mutation, input_occurred_at,
    statement_timestamp()
  ) returning id
$$;

create function helix_active_search_shadow_indexes()
returns table (shadow_index_uid text) language sql stable security definer
set search_path = pg_catalog, public as $$
  select job.shadow_index_uid from search_reindex_jobs job
  where job.status in ('queued', 'processing') order by job.created_at, job.id
$$;

create function helix_search_replay_page(input_after bigint, input_limit integer)
returns table (id bigint, mutation jsonb) language sql stable security definer
set search_path = pg_catalog, public as $$
  select item.id, item.mutation from search_index_mutations item
  where item.id > input_after
    and item.id <= (select last_mutation_id from search_index_checkpoints where consumer = 'live')
    and item.status = 'completed'
  order by item.id limit greatest(0, least(coalesce(input_limit, 0), 1000))
$$;

create function helix_search_reindex_id_page(
  input_type text, input_updated_at timestamptz, input_id uuid, input_limit integer
) returns table (id uuid, org_id uuid, updated_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  if input_type = 'mail' then
    return query select item.id, item.org_id, item.updated_at from messages item
      where item.kind = 'mail' and item.deleted_at is null
        and (input_updated_at is null or (item.updated_at, item.id) > (input_updated_at, input_id))
      order by item.updated_at, item.id limit greatest(1, least(coalesce(input_limit, 100), 1000));
  elsif input_type = 'chat' then
    return query select item.id, item.org_id, item.updated_at from messages item
      where item.kind = 'chat' and item.deleted_at is null
        and (input_updated_at is null or (item.updated_at, item.id) > (input_updated_at, input_id))
      order by item.updated_at, item.id limit greatest(1, least(coalesce(input_limit, 100), 1000));
  elsif input_type = 'docs' then
    return query select item.id, item.org_id, item.updated_at from docs_documents item
      where item.deleted_at is null
        and (input_updated_at is null or (item.updated_at, item.id) > (input_updated_at, input_id))
      order by item.updated_at, item.id limit greatest(1, least(coalesce(input_limit, 100), 1000));
  elsif input_type = 'drive' then
    return query select item.id, item.org_id, item.updated_at from objects item
      where item.kind = 'file' and item.deleted_at is null
        and (input_updated_at is null or (item.updated_at, item.id) > (input_updated_at, input_id))
      order by item.updated_at, item.id limit greatest(1, least(coalesce(input_limit, 100), 1000));
  elsif input_type = 'calendar' then
    return query select item.id, item.org_id, item.updated_at from cal_events item
      where item.deleted_at is null and item.status <> 'cancelled'
        and (input_updated_at is null or (item.updated_at, item.id) > (input_updated_at, input_id))
      order by item.updated_at, item.id limit greatest(1, least(coalesce(input_limit, 100), 1000));
  else
    raise exception 'Unsupported search reindex type: %', input_type using errcode = '22023';
  end if;
end $$;

create function helix_claim_search_index_mutations(input_owner text, input_limit integer, input_lease_seconds integer)
returns setof search_index_mutations language sql volatile security definer
set search_path = pg_catalog, public as $$
  with due as (
    select id from search_index_mutations
    where (status = 'queued' and next_attempt_at <= statement_timestamp())
       or (status = 'processing' and lease_expires_at <= statement_timestamp())
    order by id limit greatest(0, least(coalesce(input_limit, 0), 100))
    for update skip locked
  )
  update search_index_mutations item
  set status = 'processing', attempt_count = attempt_count + 1, next_attempt_at = null,
      lease_owner = left(coalesce(input_owner, 'search-indexer'), 200), lease_token = gen_random_uuid(),
      lease_expires_at = statement_timestamp() + make_interval(secs => greatest(1, least(coalesce(input_lease_seconds, 300), 3600))),
      updated_at = statement_timestamp()
  from due where item.id = due.id returning item.*
$$;

create function helix_complete_search_index_mutation(input_id bigint, input_lease_token uuid)
returns boolean language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
declare changed boolean;
declare checkpoint bigint;
begin
  update search_index_mutations set status = 'completed', completed_at = statement_timestamp(),
    lease_owner = null, lease_token = null, lease_expires_at = null, last_error = null,
    updated_at = statement_timestamp()
  where id = input_id and status = 'processing' and lease_token = input_lease_token;
  get diagnostics changed = row_count;
  if changed then
    select coalesce(
      (select min(id) - 1 from search_index_mutations where status <> 'completed'),
      (select coalesce(max(id), 0) from search_index_mutations)
    ) into checkpoint;
    insert into search_index_checkpoints (consumer, last_mutation_id, updated_at)
      values ('live', checkpoint, statement_timestamp())
      on conflict (consumer) do update set last_mutation_id = excluded.last_mutation_id,
        updated_at = excluded.updated_at;
  end if;
  return changed;
end $$;

create function helix_fail_search_index_mutation(
  input_id bigint, input_lease_token uuid, input_error text,
  input_retry_delay_seconds integer, input_max_attempts integer
) returns boolean language sql volatile security definer
set search_path = pg_catalog, public as $$
  with failed as (
    update search_index_mutations
    set status = case when attempt_count >= greatest(1, least(coalesce(input_max_attempts, 5), 100))
          then 'dead_lettered' else 'queued' end,
        next_attempt_at = case when attempt_count >= greatest(1, least(coalesce(input_max_attempts, 5), 100))
          then null else statement_timestamp() + make_interval(secs => greatest(0, least(coalesce(input_retry_delay_seconds, 1), 86400))) end,
        dead_lettered_at = case when attempt_count >= greatest(1, least(coalesce(input_max_attempts, 5), 100))
          then statement_timestamp() else null end,
        lease_owner = null, lease_token = null, lease_expires_at = null,
        last_error = left(coalesce(input_error, 'Search projection failed'), 4000), updated_at = statement_timestamp()
    where id = input_id and status = 'processing' and lease_token = input_lease_token returning 1
  ) select exists(select 1 from failed)
$$;

create function helix_replay_search_index_mutation(input_id bigint)
returns boolean language sql volatile security definer
set search_path = pg_catalog, public as $$
  with replayed as (
    update search_index_mutations set status = 'queued', next_attempt_at = statement_timestamp(),
      dead_lettered_at = null, last_error = null, updated_at = statement_timestamp()
    where id = input_id and status = 'dead_lettered' returning 1
  ) select exists(select 1 from replayed)
$$;

create function helix_claim_search_reindex_jobs(input_owner text, input_limit integer, input_lease_seconds integer)
returns setof search_reindex_jobs language sql volatile security definer
set search_path = pg_catalog, public as $$
  with due as (
    select id from search_reindex_jobs
    where (status = 'queued' and next_attempt_at <= statement_timestamp())
       or (status = 'processing' and lease_expires_at <= statement_timestamp())
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

create function helix_checkpoint_search_reindex_job(
  input_id uuid, input_lease_token uuid, input_phase text, input_source_index integer,
  input_source_cursor jsonb, input_replay_mutation_id bigint, input_document_count integer
) returns boolean language sql volatile security definer
set search_path = pg_catalog, public as $$
  with saved as (
    update search_reindex_jobs set status = 'queued', phase = input_phase,
      source_index = input_source_index, source_cursor = input_source_cursor,
      replay_mutation_id = input_replay_mutation_id,
      total_documents = total_documents + greatest(0, input_document_count),
      attempt_count = 0,
      next_attempt_at = statement_timestamp(), lease_owner = null, lease_token = null,
      lease_expires_at = null, last_error = null, updated_at = statement_timestamp()
    where id = input_id and status = 'processing' and lease_token = input_lease_token returning 1
  ) select exists(select 1 from saved)
$$;

create function helix_complete_search_reindex_job(input_id uuid, input_lease_token uuid)
returns boolean language sql volatile security definer
set search_path = pg_catalog, public as $$
  with completed as (
    update search_reindex_jobs set status = 'completed', completed_at = statement_timestamp(),
      lease_owner = null, lease_token = null, lease_expires_at = null, last_error = null,
      updated_at = statement_timestamp()
    where id = input_id and status = 'processing' and lease_token = input_lease_token returning 1
  ) select exists(select 1 from completed)
$$;

create function helix_fail_search_reindex_job(
  input_id uuid, input_lease_token uuid, input_error text,
  input_retry_delay_seconds integer, input_max_attempts integer
) returns boolean language sql volatile security definer
set search_path = pg_catalog, public as $$
  with failed as (
    update search_reindex_jobs set
      status = case when attempt_count >= greatest(1, least(coalesce(input_max_attempts, 5), 100)) then 'dead_lettered' else 'queued' end,
      next_attempt_at = case when attempt_count >= greatest(1, least(coalesce(input_max_attempts, 5), 100)) then null
        else statement_timestamp() + make_interval(secs => greatest(0, least(coalesce(input_retry_delay_seconds, 1), 86400))) end,
      dead_lettered_at = case when attempt_count >= greatest(1, least(coalesce(input_max_attempts, 5), 100)) then statement_timestamp() else null end,
      lease_owner = null, lease_token = null, lease_expires_at = null,
      last_error = left(coalesce(input_error, 'Search reindex failed'), 4000), updated_at = statement_timestamp()
    where id = input_id and status = 'processing' and lease_token = input_lease_token returning 1
  ) select exists(select 1 from failed)
$$;

create function helix_cancel_search_reindex_job(input_id uuid, input_org_id uuid)
returns boolean language sql volatile security definer
set search_path = pg_catalog, public as $$
  with locked as materialized (
    select pg_advisory_xact_lock(hashtextextended('helix-search-live-swap', 0))
  ), cancelled as (
    update search_reindex_jobs set status = 'cancelled', cancelled_at = statement_timestamp(),
      next_attempt_at = null, lease_owner = null, lease_token = null, lease_expires_at = null,
      updated_at = statement_timestamp()
    where id = input_id and org_id = input_org_id and status in ('queued', 'processing')
      and exists(select 1 from locked) returning 1
  ) select exists(select 1 from cancelled)
$$;

create function helix_search_reindex_lease_active(input_id uuid, input_lease_token uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public as $$
  select exists(
    select 1 from search_reindex_jobs
    where id = input_id and status = 'processing' and lease_token = input_lease_token
  )
$$;

alter table search_index_mutations enable row level security;
alter table search_index_mutations force row level security;
create policy helix_tenant_isolation on search_index_mutations
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());
alter table search_reindex_jobs enable row level security;
alter table search_reindex_jobs force row level security;
create policy helix_tenant_isolation on search_reindex_jobs
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());

revoke all on search_index_mutations, search_index_checkpoints, search_reindex_jobs from public, helix_readonly;
grant select, insert on search_index_mutations to helix_app, helix_worker;
grant select on search_index_checkpoints to helix_app, helix_worker;
grant select, insert on search_reindex_jobs to helix_app, helix_worker;
grant usage, select on sequence search_index_mutations_id_seq to helix_app, helix_worker;
revoke execute on function helix_claim_search_index_mutations(text, integer, integer),
  helix_enqueue_search_index_mutation(uuid, text, jsonb, timestamptz),
  helix_active_search_shadow_indexes(),
  helix_search_replay_page(bigint, integer),
  helix_search_reindex_id_page(text, timestamptz, uuid, integer),
  helix_complete_search_index_mutation(bigint, uuid),
  helix_fail_search_index_mutation(bigint, uuid, text, integer, integer),
  helix_replay_search_index_mutation(bigint),
  helix_claim_search_reindex_jobs(text, integer, integer),
  helix_checkpoint_search_reindex_job(uuid, uuid, text, integer, jsonb, bigint, integer),
  helix_complete_search_reindex_job(uuid, uuid),
  helix_fail_search_reindex_job(uuid, uuid, text, integer, integer),
  helix_cancel_search_reindex_job(uuid, uuid) from public;
revoke execute on function helix_search_reindex_lease_active(uuid, uuid) from public;
grant execute on function helix_claim_search_index_mutations(text, integer, integer),
  helix_enqueue_search_index_mutation(uuid, text, jsonb, timestamptz),
  helix_active_search_shadow_indexes(),
  helix_search_replay_page(bigint, integer),
  helix_search_reindex_id_page(text, timestamptz, uuid, integer),
  helix_complete_search_index_mutation(bigint, uuid),
  helix_fail_search_index_mutation(bigint, uuid, text, integer, integer),
  helix_replay_search_index_mutation(bigint),
  helix_claim_search_reindex_jobs(text, integer, integer),
  helix_checkpoint_search_reindex_job(uuid, uuid, text, integer, jsonb, bigint, integer),
  helix_complete_search_reindex_job(uuid, uuid),
  helix_fail_search_reindex_job(uuid, uuid, text, integer, integer),
  helix_cancel_search_reindex_job(uuid, uuid) to helix_app, helix_worker;
grant execute on function helix_search_reindex_lease_active(uuid, uuid) to helix_app, helix_worker;
