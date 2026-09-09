-- Retain legacy evidence while moving live work to the canonical v1 lifecycles.
-- An API idempotency key belongs to a principal, not every actor in the tenant.
drop index if exists mail_outbound_idempotency_key_uidx;
create unique index if not exists mail_outbound_idempotency_idx
  on mail_outbound_messages (org_id, actor_id, idempotency_key)
  where idempotency_key is not null;

alter table mail_suppressions add column legacy_source_event_id uuid
  references mail_provider_delivery_events(id) on delete restrict;
insert into mail_suppressions (
  id, org_id, address, reason, legacy_source_event_id, created_at,
  removed_at, removed_by, remove_reason
)
select id, org_id, normalized_recipient, reason::mail_suppression_reason,
  source_event_id, created_at, cleared_at, cleared_by, clear_reason
from mail_suppressions_legacy
on conflict do nothing;

-- Never expose an old quarantined object merely because its metadata predates
-- the finalization lifecycle. Preserve the old jobs, including their evidence.
update objects set metadata = metadata || '{"status":"infected"}'::jsonb
where upload_state = 'quarantined' and deleted_at is null;

insert into drive_scan_jobs (
  org_id, object_id, actor_id, status, attempt_count, next_attempt_at,
  last_error, finalize_metadata, created_at, updated_at
)
select distinct on (job.org_id, job.object_id)
  job.org_id, job.object_id, coalesce(job.requested_by_actor_id, object.owner_actor_id),
  case when job.status::text = 'failed' then 'dead_lettered' else 'pending' end,
  job.attempts,
  case when job.status::text = 'failed' then null else now() end,
  job.last_error_code, '{}'::jsonb, job.created_at, now()
from drive_scan_jobs_legacy job
join objects object on object.id = job.object_id and object.org_id = job.org_id
where job.status::text in ('pending', 'running', 'retry_scheduled', 'failed')
  and object.deleted_at is null and object.upload_state <> 'quarantined'
order by job.org_id, job.object_id, job.created_at desc, job.id desc
on conflict (org_id, object_id) do nothing;

update objects object
set metadata = object.metadata || jsonb_build_object(
  'status', case when job.status = 'dead_lettered' then 'scan_dead_letter' else 'scan_pending' end
)
from drive_scan_jobs job
where object.org_id = job.org_id and object.id = job.object_id
  and object.deleted_at is null
  and coalesce(object.metadata->>'status', 'ready') not in ('infected', 'quarantined', 'scan_processing');

-- Keep the public state column and the canonical metadata lifecycle consistent.
create function helix_project_drive_upload_state() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  new.upload_state := (case
    when new.deleted_at is not null then 'trashed'
    when new.metadata->>'status' in ('prepared', 'pending_upload') then 'pending_upload'
    when new.metadata->>'status' in ('scan_pending', 'scan_processing') then 'scanning'
    when new.metadata->>'status' in ('infected', 'quarantined') then 'quarantined'
    when new.metadata->>'status' in ('scan_failed', 'scan_dead_letter') then 'scan_failed'
    when coalesce(new.metadata->>'status', 'ready') = 'ready' then 'active'
    else 'uploaded' end)::public.drive_upload_state;
  return new;
end;
$$;
create trigger objects_project_drive_upload_state
before insert or update of metadata, deleted_at on objects
for each row execute function helix_project_drive_upload_state();
update objects set metadata = metadata;

alter table drive_scan_jobs_legacy force row level security;
alter table mail_suppressions_legacy force row level security;
revoke insert, update, delete on drive_scan_jobs_legacy, mail_suppressions_legacy
  from helix_app, helix_worker, helix_readonly;

drop trigger if exists admin_domains_fill_legacy_challenge on admin_domains;
drop function if exists helix_fill_legacy_domain_challenge();
