-- Durable room events are the recovery source for every realtime replica.
-- The room settings row is the single sequence allocator, so concurrent
-- publishers cannot create duplicates or reorder committed events.

alter table chat_room_settings
  add column if not exists next_event_sequence bigint not null default 0,
  add column if not exists acl_version bigint not null default 0;

create table if not exists chat_room_events (
  org_id uuid not null,
  room_id uuid not null,
  sequence bigint not null check (sequence > 0),
  event jsonb not null,
  created_at timestamptz not null default now(),
  primary key (room_id, sequence),
  constraint chat_room_events_room_org_fk
    foreign key (org_id, room_id) references threads (org_id, id) on delete cascade,
  constraint chat_room_events_shape_check check (
    jsonb_typeof(event) = 'object'
    and nullif(event->>'type', '') is not null
    and event->>'roomId' = room_id::text
    and event->>'orgId' = org_id::text
    and (event->>'cursor')::bigint = sequence
  )
);

create unique index if not exists chat_room_events_message_created_idx
  on chat_room_events (room_id, ((event->'message'->>'id')))
  where event->>'type' = 'message.created';

alter table chat_room_events enable row level security;
alter table chat_room_events force row level security;
drop policy if exists helix_tenant_isolation on chat_room_events;
create policy helix_tenant_isolation on chat_room_events
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

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
  values ('chat.room.' || target_room_id::text || '.events', sequenced_event);

  return query select allocated_sequence, sequenced_event;
end
$$;
