alter table pending_actions
  add column if not exists trace_id text,
  add column if not exists result jsonb,
  add column if not exists error text;
