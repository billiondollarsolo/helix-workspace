-- Durable first-pass operation log for native Sheets OT collaboration.
-- The websocket room can hydrate revision state after reconnect/restart while
-- richer replay, compaction, and cross-replica fanout remain follow-up work.

create table if not exists sheet_op_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  sheet_id uuid not null references sheets(id) on delete cascade,
  sheet_tab_id uuid not null references sheet_tabs(id) on delete cascade,
  actor_id uuid references actors(id),
  operation_id text not null,
  revision integer not null,
  base_revision integer not null,
  operation jsonb not null,
  created_at timestamptz not null default now(),
  constraint sheet_op_log_revision_positive check (revision > 0),
  constraint sheet_op_log_base_revision_non_negative check (base_revision >= 0),
  constraint sheet_op_log_operation_object check (jsonb_typeof(operation) = 'object')
);

create unique index if not exists sheet_op_log_sheet_revision_idx
  on sheet_op_log (sheet_id, revision);

create unique index if not exists sheet_op_log_sheet_operation_idx
  on sheet_op_log (sheet_id, operation_id);

create index if not exists sheet_op_log_org_sheet_revision_idx
  on sheet_op_log (org_id, sheet_id, revision);

create index if not exists sheet_op_log_org_created_idx
  on sheet_op_log (org_id, created_at desc);

alter table sheet_op_log enable row level security;

drop policy if exists helix_tenant_isolation on sheet_op_log;
create policy helix_tenant_isolation on sheet_op_log
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
