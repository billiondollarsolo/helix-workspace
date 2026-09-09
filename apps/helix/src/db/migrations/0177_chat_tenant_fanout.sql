-- Durable repair and direct fanout must use the same tenant-bound subject.
create or replace function append_chat_room_event(
  target_org_id uuid,
  target_room_id uuid,
  raw_event jsonb
)
returns table (event_sequence bigint, stored_event jsonb)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $$
declare
  allocated_sequence bigint;
  sequenced_event jsonb;
begin
  update public.chat_room_settings
  set next_event_sequence = next_event_sequence + 1
  where org_id = target_org_id and thread_id = target_room_id
  returning next_event_sequence into allocated_sequence;

  if not found then
    raise foreign_key_violation using
      message = 'chat events require a room in the same organization';
  end if;
  if allocated_sequence > 9007199254740991 then
    raise numeric_value_out_of_range using
      message = 'chat room event cursor exceeds the JSON safe-integer range';
  end if;

  sequenced_event := raw_event || jsonb_build_object(
    'orgId', target_org_id,
    'roomId', target_room_id,
    'cursor', allocated_sequence
  );

  insert into public.chat_room_events (org_id, room_id, sequence, event)
  values (target_org_id, target_room_id, allocated_sequence, sequenced_event);

  -- The direct publisher provides low latency; this outbox copy repairs a
  -- crash between commit and fanout. Cursor de-duplication makes both safe.
  insert into public.outbox (subject, payload)
  values ('chat.org.' || target_org_id::text || '.room.' || target_room_id::text || '.events', sequenced_event);

  return query select allocated_sequence, sequenced_event;
end
$$;

update outbox set subject = 'chat.org.' || (payload->>'orgId') || '.room.' || (payload->>'roomId') || '.events'
where subject = 'chat.room.' || (payload->>'roomId') || '.events'
  and payload->>'orgId' ~ '^[a-f0-9-]{36}$';
