-- Bounded retry / dead-letter columns for outbound dispatch.
alter table mail_outbound_messages
  add column if not exists attempt_count int not null default 0,
  add column if not exists next_attempt_at timestamptz null,
  add column if not exists dead_lettered_at timestamptz null;

create index if not exists mail_outbound_retry_idx
  on mail_outbound_messages (status, next_attempt_at)
  where dead_lettered_at is null;
