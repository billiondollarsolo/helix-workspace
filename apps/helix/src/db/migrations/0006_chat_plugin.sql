create table if not exists chat_room_settings (
  thread_id uuid primary key references threads(id) on delete cascade,
  org_id uuid not null,
  name text,
  topic text,
  is_private boolean not null default false,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chat_room_settings_org_idx on chat_room_settings (org_id);

create table if not exists chat_reactions (
  message_id uuid not null references messages(id) on delete cascade,
  actor_id uuid not null references actors(id) on delete cascade,
  org_id uuid not null,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, actor_id, emoji)
);

create index if not exists chat_reactions_org_emoji_idx on chat_reactions (org_id, emoji);

create table if not exists chat_pins (
  message_id uuid not null references messages(id) on delete cascade,
  thread_id uuid not null references threads(id) on delete cascade,
  org_id uuid not null,
  pinned_by_actor_id uuid references actors(id),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  primary key (thread_id, message_id)
);

create index if not exists chat_pins_org_thread_idx on chat_pins (org_id, thread_id);

create table if not exists chat_read_receipts (
  thread_id uuid not null references threads(id) on delete cascade,
  actor_id uuid not null references actors(id) on delete cascade,
  org_id uuid not null,
  last_read_message_id uuid references messages(id) on delete set null,
  last_read_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (thread_id, actor_id)
);

create index if not exists chat_read_receipts_actor_idx on chat_read_receipts (actor_id, updated_at);
