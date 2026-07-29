-- Durable, idempotent user notifications for the safety-critical pending
-- action lifecycle. Keeping this projection in the same database transaction
-- as the state change prevents process crashes from losing the notification.

create unique index if not exists notifications_pending_action_state_idx
  on notifications (org_id, actor_id, verb, object_type, object_id)
  where object_type = 'pending_action';

create or replace function notify_pending_action_state()
returns trigger
language plpgsql
as $$
declare
  recipient_actor_id uuid;
  notification_summary text;
begin
  if new.status not in ('pending_confirmation', 'executed', 'failed', 'cancelled', 'expired') then
    return new;
  end if;

  if tg_op = 'UPDATE' and old.status = new.status then
    return new;
  end if;

  recipient_actor_id := coalesce(new.approval_owner_actor_id, new.requester_actor_id);
  notification_summary := case new.status
    when 'pending_confirmation' then 'Action approval required'
    when 'executed' then 'Approved action completed'
    when 'failed' then 'Approved action failed'
    when 'cancelled' then 'Pending action cancelled'
    when 'expired' then 'Pending action expired'
  end;

  insert into notifications (
    org_id,
    actor_id,
    verb,
    object_type,
    object_id,
    summary,
    payload
  )
  values (
    new.org_id,
    recipient_actor_id,
    'pending_action.' || new.status::text,
    'pending_action',
    new.id,
    notification_summary,
    jsonb_build_object(
      'pendingActionId', new.id,
      'toolId', new.tool_id,
      'status', new.status,
      'createdAt', new.created_at,
      'expiresAt', new.expires_at,
      'traceId', new.trace_id
    )
  )
  on conflict (org_id, actor_id, verb, object_type, object_id)
    where object_type = 'pending_action'
  do nothing;

  return new;
end;
$$;

drop trigger if exists pending_actions_notify_state on pending_actions;
create trigger pending_actions_notify_state
after insert or update of status on pending_actions
for each row execute function notify_pending_action_state();
