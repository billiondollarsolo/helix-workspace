-- True draft persistence (queued-for-send undo window is not a draft).
create table if not exists mail_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  actor_id uuid not null,
  thread_id uuid null references threads(id) on delete set null,
  envelope jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mail_drafts_actor_idx
  on mail_drafts (org_id, actor_id, updated_at desc);
