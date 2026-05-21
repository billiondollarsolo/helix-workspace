alter table mail_thread_state
  add column if not exists read_at timestamptz,
  add column if not exists starred boolean not null default false;

create index if not exists mail_thread_state_starred_idx on mail_thread_state (org_id, actor_id, starred)
  where starred = true;
