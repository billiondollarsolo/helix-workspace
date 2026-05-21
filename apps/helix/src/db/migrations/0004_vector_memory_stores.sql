create extension if not exists vector;

do $$ begin
  create type vector_metric as enum ('cosine', 'dot', 'l2');
exception when duplicate_object then null; end $$;

alter table memory_items
  add column if not exists source text not null default 'assistant.conversation',
  add column if not exists expires_at timestamptz;

alter table memory_items
  alter column embedding type vector(768) using embedding::vector(768);

create index if not exists memory_items_actor_created_idx on memory_items (actor_id, created_at);

create table if not exists vector_collections (
  name text primary key,
  dim integer not null,
  metric vector_metric not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists vector_items (
  collection_name text not null references vector_collections(name) on delete cascade,
  id text not null,
  embedding vector not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (collection_name, id)
);

create index if not exists vector_items_collection_idx on vector_items (collection_name);
create index if not exists vector_items_metadata_idx on vector_items using gin (metadata);
