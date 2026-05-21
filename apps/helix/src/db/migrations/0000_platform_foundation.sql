create extension if not exists pgcrypto;
create extension if not exists vector;

do $$ begin
  create type actor_type as enum ('user', 'agent', 'service_account', 'system');
exception when duplicate_object then null; end $$;

do $$ begin
  create type object_kind as enum ('file', 'mail_attachment', 'document', 'recording', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type thread_kind as enum ('mail', 'chat_room', 'chat_dm', 'doc', 'calendar', 'call');
exception when duplicate_object then null; end $$;

do $$ begin
  create type message_kind as enum ('mail', 'chat', 'comment', 'system');
exception when duplicate_object then null; end $$;

do $$ begin
  create type pending_action_status as enum ('pending_confirmation', 'confirmed', 'cancelled', 'expired');
exception when duplicate_object then null; end $$;

create table if not exists actors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  type actor_type not null,
  email text,
  display_name text not null,
  parent_user_id uuid references actors(id),
  scopes text[] not null default '{}',
  disabled_at timestamptz,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists actors_org_email_idx on actors (org_id, email);
create index if not exists actors_parent_user_idx on actors (parent_user_id);

create table if not exists objects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  owner_actor_id uuid references actors(id),
  kind object_kind not null,
  storage_key text not null,
  mime_type text not null,
  byte_size integer not null,
  sha256 text,
  classification text not null default 'internal',
  metadata jsonb not null default '{}',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists objects_org_kind_idx on objects (org_id, kind);
create index if not exists objects_owner_actor_idx on objects (owner_actor_id);

create table if not exists threads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  kind thread_kind not null,
  subject text,
  created_by_actor_id uuid references actors(id),
  metadata jsonb not null default '{}',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists threads_org_kind_idx on threads (org_id, kind);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  thread_id uuid not null references threads(id),
  actor_id uuid references actors(id),
  kind message_kind not null,
  body text not null,
  body_format text not null default 'plain',
  metadata jsonb not null default '{}',
  sent_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists messages_thread_sent_idx on messages (thread_id, sent_at);
create index if not exists messages_org_kind_idx on messages (org_id, kind);

create table if not exists message_attachments (
  message_id uuid not null references messages(id),
  object_id uuid not null references objects(id),
  disposition text not null default 'attachment',
  primary key (message_id, object_id)
);

create table if not exists permissions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  actor_id uuid not null references actors(id),
  resource_type text not null,
  resource_id uuid not null,
  role text not null,
  granted_by_actor_id uuid references actors(id),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists permissions_resource_idx on permissions (resource_type, resource_id);
create index if not exists permissions_actor_idx on permissions (actor_id);

create table if not exists activity (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  actor_id uuid references actors(id),
  verb text not null,
  object_type text not null,
  object_id uuid,
  trace_id text,
  payload jsonb not null default '{}',
  prev_hash text,
  this_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists activity_org_created_idx on activity (org_id, created_at);
create unique index if not exists activity_hash_idx on activity (this_hash);

create table if not exists outbox (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  payload jsonb not null,
  trace_id text,
  span_id text,
  traceparent text,
  tracestate text,
  deliver_after timestamptz not null default now(),
  delivered_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);

create index if not exists outbox_pending_idx on outbox (deliver_after, delivered_at);

create table if not exists ai_artifacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  actor_id uuid references actors(id),
  provider_id text not null,
  model text not null,
  feature text not null,
  input_hash text not null,
  output_hash text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists memory_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  actor_id uuid not null references actors(id),
  content text not null,
  embedding vector,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists memory_items_actor_idx on memory_items (actor_id);

create table if not exists pending_actions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  actor_id uuid not null references actors(id),
  tool_id text not null,
  input jsonb not null,
  status pending_action_status not null default 'pending_confirmation',
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  trace_id text,
  result jsonb,
  error text
);

create table if not exists app_passwords (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references actors(id),
  label text not null,
  hash text not null,
  scopes text[] not null default '{}',
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists app_passwords_actor_idx on app_passwords (actor_id);

create table if not exists platform_config (
  key text primary key,
  value jsonb not null,
  sensitive boolean not null default false,
  updated_by_actor_id uuid references actors(id),
  updated_at timestamptz not null default now()
);

create table if not exists installed_plugins (
  id text primary key,
  version text not null,
  enabled boolean not null default false,
  manifest jsonb not null,
  state text not null default 'discovered',
  migrations_applied text[] not null default '{}',
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists plugin_migrations (
  plugin_id text not null references installed_plugins(id) on delete cascade,
  name text not null,
  applied_at timestamptz not null default now(),
  primary key (plugin_id, name)
);

create table if not exists agent_credentials (
  id uuid primary key default gen_random_uuid(),
  agent_actor_id uuid not null references actors(id),
  client_id text not null,
  client_secret_hash text not null,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists agent_credentials_client_idx on agent_credentials (client_id);
create index if not exists agent_credentials_actor_idx on agent_credentials (agent_actor_id);
