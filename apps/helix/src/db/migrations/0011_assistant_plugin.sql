create table if not exists assistant_conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  actor_id uuid not null references actors(id),
  title text,
  memory_opt_in boolean not null default false,
  metadata jsonb not null default '{}',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists assistant_conversations_actor_updated_idx
  on assistant_conversations (actor_id, updated_at);
create index if not exists assistant_conversations_org_updated_idx
  on assistant_conversations (org_id, updated_at);

create table if not exists assistant_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  conversation_id uuid not null references assistant_conversations(id) on delete cascade,
  actor_id uuid references actors(id),
  role text not null,
  content text not null,
  tool_call_id text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  constraint assistant_messages_role_check check (role in ('system', 'user', 'assistant', 'tool'))
);

create index if not exists assistant_messages_conversation_created_idx
  on assistant_messages (conversation_id, created_at);
create index if not exists assistant_messages_org_actor_created_idx
  on assistant_messages (org_id, actor_id, created_at);

create table if not exists assistant_memory_preferences (
  org_id uuid not null,
  actor_id uuid not null references actors(id) on delete cascade,
  enabled boolean not null default false,
  metadata jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (org_id, actor_id)
);

create index if not exists assistant_memory_preferences_actor_idx
  on assistant_memory_preferences (actor_id);
