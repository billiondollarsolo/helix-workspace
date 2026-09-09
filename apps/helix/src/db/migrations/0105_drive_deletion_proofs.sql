alter table drive_quarantine_deletions
  drop constraint if exists drive_quarantine_deletions_status_check;
alter table drive_quarantine_deletions
  drop constraint if exists drive_quarantine_deletions_state_check;
alter table drive_quarantine_deletions
  add column if not exists completed_at timestamptz;
alter table drive_quarantine_deletions
  add constraint drive_quarantine_deletions_status_check
    check (status in ('pending', 'processing', 'completed'));
alter table drive_quarantine_deletions
  add constraint drive_quarantine_deletions_state_check check (
    (status = 'pending' and lease_expires_at is null and completed_at is null)
    or (status = 'processing' and lease_expires_at is not null and completed_at is null)
    or (status = 'completed' and lease_expires_at is null and completed_at is not null)
  );
