-- Durable dual control for irreversible administrative operations. Existing
-- tool confirmations retain their single-actor semantics; crown-jewel rows
-- opt into a distinct approver and can be consumed exactly once.
alter table pending_actions
  add column if not exists approval_kind text not null default 'self_confirmation',
  add column if not exists approved_by_actor_id uuid,
  add column if not exists approved_at timestamptz,
  add column if not exists consumed_at timestamptz;

alter table pending_actions
  drop constraint if exists pending_actions_approval_kind_check,
  add constraint pending_actions_approval_kind_check
    check (approval_kind in ('self_confirmation', 'distinct_actor')),
  drop constraint if exists pending_actions_distinct_approver_check,
  add constraint pending_actions_distinct_approver_check
    check (
      approval_kind <> 'distinct_actor'
      or approved_by_actor_id is null
      or approved_by_actor_id <> actor_id
    ),
  drop constraint if exists pending_actions_approved_actor_org_fk,
  add constraint pending_actions_approved_actor_org_fk
    foreign key (org_id, approved_by_actor_id) references actors (org_id, id);

create index if not exists pending_actions_crown_jewel_pending_idx
  on pending_actions (org_id, expires_at)
  where approval_kind = 'distinct_actor' and consumed_at is null;
