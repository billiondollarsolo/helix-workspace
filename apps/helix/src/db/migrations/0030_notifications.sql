create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  actor_id uuid not null references actors(id) on delete cascade,
  verb text not null,
  object_type text not null,
  object_id uuid,
  summary text not null,
  body text,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists notifications_actor_recent_idx
  on notifications (actor_id, created_at desc);

create index if not exists notifications_actor_unread_idx
  on notifications (actor_id, created_at desc)
  where read_at is null;

create index if not exists notifications_org_verb_idx
  on notifications (org_id, verb, created_at desc);
