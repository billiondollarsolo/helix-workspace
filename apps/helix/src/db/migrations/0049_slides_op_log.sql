-- Durable first-pass operation log for native Slides collaboration.
-- The websocket room can hydrate revision/idempotency state after reconnect
-- or process restart while full Yjs state, replay compaction, and NATS fanout
-- remain follow-up work.

create table if not exists slides_op_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  deck_id uuid not null references slide_decks(id) on delete cascade,
  actor_id uuid references actors(id),
  operation_id text not null,
  revision integer not null,
  base_revision integer not null,
  operation jsonb not null,
  created_at timestamptz not null default now(),
  constraint slides_op_log_revision_positive check (revision > 0),
  constraint slides_op_log_base_revision_non_negative check (base_revision >= 0),
  constraint slides_op_log_operation_object check (jsonb_typeof(operation) = 'object')
);

create unique index if not exists slides_op_log_deck_revision_idx
  on slides_op_log (deck_id, revision);

create unique index if not exists slides_op_log_deck_operation_idx
  on slides_op_log (deck_id, operation_id);

create index if not exists slides_op_log_org_deck_revision_idx
  on slides_op_log (org_id, deck_id, revision);

create index if not exists slides_op_log_org_created_idx
  on slides_op_log (org_id, created_at desc);

alter table slides_op_log enable row level security;

drop policy if exists helix_tenant_isolation on slides_op_log;
create policy helix_tenant_isolation on slides_op_log
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
