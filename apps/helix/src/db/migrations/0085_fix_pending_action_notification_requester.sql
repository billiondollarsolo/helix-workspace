-- Repair installations that already applied 0083 with a trigger function
-- referencing the nonexistent pending_actions.requester_actor_id column.
-- pending_actions.actor_id is the durable requester identity; the explicit
-- approval owner continues to take precedence when one is assigned.

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

  recipient_actor_id := coalesce(new.approval_owner_actor_id, new.actor_id);
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
