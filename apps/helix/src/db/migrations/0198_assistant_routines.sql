create table if not exists assistant_routines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  actor_id uuid not null references actors(id) on delete cascade,
  conversation_id uuid references assistant_conversations(id) on delete set null,
  name text not null,
  prompt text not null,
  interval_minutes integer not null check (interval_minutes between 5 and 10080),
  enabled boolean not null default true,
  next_run_at timestamptz not null,
  last_run_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists assistant_routines_due_idx
  on assistant_routines (enabled, next_run_at)
  where enabled;

create index if not exists assistant_routines_actor_idx
  on assistant_routines (org_id, actor_id, created_at desc);
