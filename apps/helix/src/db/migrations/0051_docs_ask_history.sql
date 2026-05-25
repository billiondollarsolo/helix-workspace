create table if not exists docs_ask_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  document_id uuid not null references docs_documents(id) on delete cascade,
  actor_id uuid not null references actors(id) on delete cascade,
  question text not null,
  answer text not null,
  source_scope text not null default 'document',
  source_excerpt text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint docs_ask_history_source_scope_check
    check (source_scope in ('document', 'selection'))
);

create index if not exists docs_ask_history_actor_document_created_idx
  on docs_ask_history (org_id, actor_id, document_id, created_at desc);

create index if not exists docs_ask_history_document_created_idx
  on docs_ask_history (org_id, document_id, created_at desc);

alter table docs_ask_history enable row level security;

drop policy if exists helix_tenant_isolation on docs_ask_history;
create policy helix_tenant_isolation on docs_ask_history
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
