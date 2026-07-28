-- RD-5 / Task 1.5 / A4: delegated, immutable and exactly-once pending actions.

do $$
begin
  if exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'pending_action_status' and e.enumlabel = 'confirmed'
  ) and not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'pending_action_status' and e.enumlabel = 'approved'
  ) then
    alter type pending_action_status rename value 'confirmed' to 'approved';
  end if;
end $$;

alter type pending_action_status add value if not exists 'approved';
alter type pending_action_status add value if not exists 'executing';
alter type pending_action_status add value if not exists 'executed';
alter type pending_action_status add value if not exists 'failed';

alter table agent_credentials
  add column if not exists approval_owner_actor_id uuid references actors(id),
  add column if not exists automation_policy jsonb,
  add column if not exists policy_version text not null default '1';

update agent_credentials
set approval_owner_actor_id = created_by
where approval_owner_actor_id is null
  and created_by is not null;

alter table pending_actions
  add column if not exists requester_credential_id uuid references agent_credentials(id),
  add column if not exists requester_principal jsonb not null default '{}',
  add column if not exists requester_ip text,
  add column if not exists approval_owner_actor_id uuid references actors(id),
  add column if not exists approver_actor_id uuid references actors(id),
  add column if not exists execution_actor_id uuid references actors(id),
  add column if not exists input_hash text not null default repeat('0', 64),
  add column if not exists policy_snapshot jsonb not null default '{"schemaVersion":"legacy"}',
  add column if not exists policy_version text not null default 'legacy',
  add column if not exists preview jsonb not null default '{"toolId":"unknown","action":"unknown","resourceIds":[],"recipients":[],"targets":[],"consequence":"Legacy pending action; cancel and recreate."}',
  add column if not exists approved_at timestamptz,
  add column if not exists execution_started_at timestamptz,
  add column if not exists execution_completed_at timestamptz,
  add column if not exists execution_lease_expires_at timestamptz,
  add column if not exists execution_attempts integer not null default 0,
  add column if not exists execution_idempotency_key text;

update pending_actions p
set requester_principal = jsonb_build_object(
  'id', p.actor_id,
  'orgId', p.org_id,
  'type', coalesce(a.type, 'agent'),
  'scopes', coalesce(to_jsonb(a.scopes), '[]'::jsonb)
)
from actors a
where a.id = p.actor_id
  and p.requester_principal = '{}'::jsonb;

update pending_actions
set execution_idempotency_key = 'pending-action:' || id::text
where execution_idempotency_key is null;

alter table pending_actions
  alter column execution_idempotency_key set not null;

create unique index if not exists pending_actions_execution_idempotency_idx
  on pending_actions (execution_idempotency_key);
create index if not exists pending_actions_execution_recovery_idx
  on pending_actions (status, execution_lease_expires_at)
  where status = 'executing';
