-- Guarded rollback for 0076_drive_upload_state.sql.
--
-- Preconditions:
--   1. Stop Helix upload and scan workers.
--   2. Take and verify a database backup.
--   3. Confirm every retained object is active (or already deleted) and the
--      durable scan queue is empty.
--
-- The guard deliberately aborts instead of discarding quarantine, retry, or
-- in-flight upload state. If it fires, restore the pre-migration backup or
-- complete/cancel the affected work before retrying this rollback.

do $$
begin
  if exists (select 1 from drive_scan_jobs) then
    raise exception
      'refusing 0076 rollback: drive_scan_jobs is not empty; preserve or settle scan state first';
  end if;

  if exists (
    select 1
    from objects
    where deleted_at is null
      and upload_state <> 'active'
  ) then
    raise exception
      'refusing 0076 rollback: non-active Drive objects would lose availability state';
  end if;
end
$$;

drop trigger if exists message_attachments_require_active_object on message_attachments;
drop function if exists helix_require_active_message_attachment();
drop table if exists drive_scan_jobs;
drop index if exists objects_org_upload_state_idx;

alter table objects
  drop column if exists upload_declared_sha256,
  drop column if exists upload_declared_byte_size,
  drop column if exists upload_state;

drop type if exists drive_scan_job_status;
drop type if exists drive_upload_state;
