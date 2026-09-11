-- Existing jobs retain their original two-approver contract. New jobs snapshot
-- the operator policy: zero approvers for solo operation or one other admin.
alter table backup_restore_jobs add column required_approvals smallint not null default 2
  check (required_approvals between 0 and 2);

create or replace function helix_approve_backup_restore_job(
  input_id uuid, input_org_id uuid, input_actor_id uuid
) returns setof backup_restore_jobs language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
declare job backup_restore_jobs;
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_actor_id then
    raise exception 'Restore approval requires the authenticated tenant and actor' using errcode = '42501';
  end if;
  select * into job from backup_restore_jobs
  where id = input_id and org_id = input_org_id for update;
  if not found or job.status <> 'pending_approval' then return; end if;
  if job.requested_by_actor_id = input_actor_id then
    raise exception 'Restore requester cannot approve their own job' using errcode = '42501';
  end if;
  insert into backup_restore_job_approvals (job_id, org_id, actor_id)
    values (job.id, job.org_id, input_actor_id) on conflict do nothing;
  if (select count(*) from backup_restore_job_approvals where job_id = job.id) >= job.required_approvals then
    update backup_restore_jobs set status = 'queued', next_attempt_at = statement_timestamp(),
      updated_at = statement_timestamp() where id = job.id returning * into job;
  end if;
  return next job;
end $$;
