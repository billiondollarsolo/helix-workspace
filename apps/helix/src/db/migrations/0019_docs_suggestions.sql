-- Docs suggestion-mode editing (TASK-604): tracked changes / proposed edits that are
-- distinct from plain comments. A suggestion proposes replacing `before_text` with
-- `after_text` at an anchored range; reviewers accept or reject it.
create table if not exists docs_suggestions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  document_id uuid not null references docs_documents(id) on delete cascade,
  actor_id uuid references actors(id),
  anchor jsonb not null default '{}',
  before_text text not null default '',
  after_text text not null default '',
  reason text not null default '',
  status text not null default 'pending',
  metadata jsonb not null default '{}',
  resolved_by_actor_id uuid references actors(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists docs_suggestions_document_status_idx
  on docs_suggestions (document_id, status);
create index if not exists docs_suggestions_org_created_idx
  on docs_suggestions (org_id, created_at);
