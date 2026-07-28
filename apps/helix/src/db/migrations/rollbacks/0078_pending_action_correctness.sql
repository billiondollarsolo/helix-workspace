-- Pending action terminal status values remain in the enum because PostgreSQL
-- cannot safely remove enum values in a reversible online migration.
-- Production rollback is restore-based. This destructive compatibility
-- rollback is permitted only after workers are stopped, a backup is verified,
-- and no post-0078 approval/execution evidence exists.
do $$
begin
  if current_setting('helix.pending_workers_stopped', true) is distinct from 'on'
    or current_setting('helix.pending_actions_backup_verified', true) is distinct from 'on'
    or current_setting('helix.allow_destructive_pending_action_rollback', true)
      is distinct from 'restore-approved'
  then
    raise exception
      '0078 rollback requires stopped pending workers, verified backup, and restore approval';
  end if;

  if exists (
    select 1
    from pending_actions
    where requester_credential_id is not null
      or policy_version <> 'legacy'
      or input_hash <> repeat('0', 64)
      or status not in ('pending_confirmation', 'expired', 'cancelled')
      or execution_attempts > 0
  ) then
    raise exception
      '0078 rollback refused: delegated approval or execution evidence would be lost; restore backup instead';
  end if;
end $$;

drop index if exists pending_actions_execution_recovery_idx;
drop index if exists pending_actions_execution_idempotency_idx;

alter table pending_actions
  drop column if exists execution_idempotency_key,
  drop column if exists execution_attempts,
  drop column if exists execution_lease_expires_at,
  drop column if exists execution_completed_at,
  drop column if exists execution_started_at,
  drop column if exists approved_at,
  drop column if exists preview,
  drop column if exists policy_version,
  drop column if exists policy_snapshot,
  drop column if exists input_hash,
  drop column if exists execution_actor_id,
  drop column if exists approver_actor_id,
  drop column if exists approval_owner_actor_id,
  drop column if exists requester_ip,
  drop column if exists requester_principal,
  drop column if exists requester_credential_id;

alter table agent_credentials
  drop column if exists policy_version,
  drop column if exists automation_policy,
  drop column if exists approval_owner_actor_id;
