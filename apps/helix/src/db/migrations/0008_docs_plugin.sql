create table if not exists docs_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  title text not null,
  thread_id uuid references threads(id) on delete set null,
  owner_actor_id uuid references actors(id),
  created_by_actor_id uuid references actors(id),
  ydoc_state bytea,
  ydoc_state_vector bytea,
  update_seq integer not null default 0,
  metadata jsonb not null default '{}',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists docs_documents_org_updated_idx on docs_documents (org_id, updated_at);
create index if not exists docs_documents_owner_idx on docs_documents (owner_actor_id);
create index if not exists docs_documents_thread_idx on docs_documents (thread_id);

create table if not exists docs_updates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  document_id uuid not null references docs_documents(id) on delete cascade,
  actor_id uuid references actors(id),
  seq integer not null,
  update bytea not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create unique index if not exists docs_updates_document_seq_idx on docs_updates (document_id, seq);
create index if not exists docs_updates_document_created_idx on docs_updates (document_id, created_at);
create index if not exists docs_updates_org_created_idx on docs_updates (org_id, created_at);

create table if not exists docs_comments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  document_id uuid not null references docs_documents(id) on delete cascade,
  actor_id uuid references actors(id),
  anchor jsonb not null default '{}',
  body text not null,
  status text not null default 'open',
  metadata jsonb not null default '{}',
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists docs_comments_document_status_idx on docs_comments (document_id, status);
create index if not exists docs_comments_org_created_idx on docs_comments (org_id, created_at);
