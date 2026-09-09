-- One durable scheduler owns outbound mail. A stable handoff key lets an
-- idempotent provider collapse a retry after the sender dies before commit.
alter table mail_outbound_messages
  add column if not exists handoff_key uuid not null default gen_random_uuid(),
  add column if not exists lease_owner text,
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz;

update mail_outbound_messages
set
  status = 'queued',
  next_attempt_at = coalesce(next_attempt_at, now()),
  lease_owner = null,
  lease_token = null,
  lease_expires_at = null
where status = 'sending';

update mail_outbound_messages
set next_attempt_at = undo_until
where status = 'queued' and next_attempt_at is null;

drop index if exists mail_outbound_retry_idx;

create unique index if not exists mail_outbound_handoff_key_idx
  on mail_outbound_messages (handoff_key);

create index if not exists mail_outbound_due_idx
  on mail_outbound_messages (next_attempt_at, id)
  where status = 'queued' and dead_lettered_at is null;

create index if not exists mail_outbound_stale_lease_idx
  on mail_outbound_messages (lease_expires_at, id)
  where status = 'sending';

alter table mail_outbound_messages
  drop constraint if exists mail_outbound_lease_state_check,
  add constraint mail_outbound_lease_state_check check (
    (status = 'sending' and next_attempt_at is null and lease_owner is not null and lease_token is not null and lease_expires_at is not null)
    or
    (status = 'queued' and next_attempt_at is not null and lease_owner is null and lease_token is null and lease_expires_at is null)
    or
    (status not in ('sending', 'queued') and lease_owner is null and lease_token is null and lease_expires_at is null)
  ),
  drop constraint if exists mail_outbound_attempt_count_check,
  add constraint mail_outbound_attempt_count_check check (attempt_count >= 0);
