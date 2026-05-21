create table if not exists meet_rooms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  thread_id uuid not null references threads(id) on delete cascade,
  room_name text not null,
  subject text not null,
  jitsi_domain text not null,
  created_by_actor_id uuid references actors(id),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'active',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meet_rooms_status_check check (status in ('active', 'ended'))
);

create unique index if not exists meet_rooms_thread_idx on meet_rooms (thread_id);
create unique index if not exists meet_rooms_org_room_name_idx on meet_rooms (org_id, room_name);
create index if not exists meet_rooms_org_status_idx on meet_rooms (org_id, status);
create index if not exists meet_rooms_created_by_idx on meet_rooms (created_by_actor_id, status);
