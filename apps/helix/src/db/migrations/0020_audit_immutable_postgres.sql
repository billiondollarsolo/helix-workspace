-- P2-2: WORM (write-once, read-many) Postgres audit destination.
--
-- PRD §15.5 / Tier 3 require an immutable audit destination beyond the
-- ImmutableS3AuditShipper. This table is the `audit-immutable-postgres`
-- destination: it is append-only and enforced as such at the database level.
--
-- The PostgresWormAuditStore (platform/audit/immutable-postgres.ts) inserts one
-- row per shipped audit record. Rows mirror the hash-chained `activity` record
-- so the offline verifier can reconcile a WORM copy against the primary log.
--
-- Immutability is enforced by a BEFORE UPDATE OR DELETE trigger that raises an
-- exception unconditionally. Unlike a revocable GRANT, the trigger blocks the
-- table owner and superusers too, so no application or operator path can
-- silently mutate or delete a shipped audit record.

create table if not exists audit_immutable_postgres (
  -- Surrogate key for this WORM copy; distinct from the source record id.
  worm_id uuid primary key default gen_random_uuid(),
  -- The id of the source `activity` row this WORM entry copies.
  record_id uuid not null,
  org_id uuid not null,
  actor_id text not null,
  on_behalf_of_actor_id text,
  verb text not null,
  object_type text not null,
  object_id text,
  tool_id text,
  trace_id text,
  span_id text,
  metadata jsonb not null default '{}'::jsonb,
  prev_hash text,
  this_hash text not null
    check (this_hash ~ '^[a-f0-9]{64}$'),
  -- createdAt of the source audit record (the hash-chain timestamp).
  record_created_at timestamptz not null,
  -- When this WORM copy was shipped/appended.
  shipped_at timestamptz not null default now()
);

-- One WORM row per source audit record — re-shipping is idempotent.
create unique index if not exists audit_immutable_postgres_record_idx
  on audit_immutable_postgres (org_id, record_id);

create index if not exists audit_immutable_postgres_org_created_idx
  on audit_immutable_postgres (org_id, record_created_at);

create index if not exists audit_immutable_postgres_hash_idx
  on audit_immutable_postgres (this_hash);

-- WORM enforcement: block every UPDATE and DELETE at the row level.
create or replace function audit_immutable_postgres_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'audit_immutable_postgres is append-only (WORM): % is not permitted',
    tg_op
    using errcode = 'integrity_constraint_violation';
end;
$$;

drop trigger if exists audit_immutable_postgres_no_update on audit_immutable_postgres;
create trigger audit_immutable_postgres_no_update
  before update on audit_immutable_postgres
  for each row
  execute function audit_immutable_postgres_block_mutation();

drop trigger if exists audit_immutable_postgres_no_delete on audit_immutable_postgres;
create trigger audit_immutable_postgres_no_delete
  before delete on audit_immutable_postgres
  for each row
  execute function audit_immutable_postgres_block_mutation();

-- TRUNCATE bypasses row-level triggers, so block it with a statement trigger.
drop trigger if exists audit_immutable_postgres_no_truncate on audit_immutable_postgres;
create trigger audit_immutable_postgres_no_truncate
  before truncate on audit_immutable_postgres
  for each statement
  execute function audit_immutable_postgres_block_mutation();
