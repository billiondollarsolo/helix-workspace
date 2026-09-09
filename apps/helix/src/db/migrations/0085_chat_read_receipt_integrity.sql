-- Every chat message gets one durable, strictly increasing position within its
-- room. Receipt advancement can therefore be enforced atomically by Postgres.

alter table chat_room_settings
  add column if not exists read_receipts_enabled boolean not null default true,
  add column if not exists next_message_sequence bigint not null default 0;

alter table messages
  add column if not exists chat_room_sequence bigint;

with ranked as (
  select
    id,
    row_number() over (partition by thread_id order by sent_at, id) as room_sequence
  from messages
  where kind = 'chat'
)
update messages m
set chat_room_sequence = ranked.room_sequence
from ranked
where m.id = ranked.id
  and m.chat_room_sequence is null;

update chat_room_settings settings
set next_message_sequence = greatest(
  settings.next_message_sequence,
  coalesce((
    select max(message.chat_room_sequence)
    from messages message
    where message.org_id = settings.org_id
      and message.thread_id = settings.thread_id
      and message.kind = 'chat'
  ), 0)
);

create unique index if not exists messages_chat_room_sequence_uidx
  on messages (thread_id, chat_room_sequence)
  where kind = 'chat';

create or replace function assign_chat_room_message_sequence()
returns trigger
language plpgsql
as $$
begin
  if new.kind = 'chat' then
    update chat_room_settings
    set next_message_sequence = next_message_sequence + 1
    where org_id = new.org_id
      and thread_id = new.thread_id
    returning next_message_sequence into new.chat_room_sequence;

    if not found then
      raise foreign_key_violation using
        message = 'chat messages require settings in the same organization';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists messages_assign_chat_room_sequence on messages;
create trigger messages_assign_chat_room_sequence
before insert on messages
for each row execute function assign_chat_room_message_sequence();

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'messages_chat_room_sequence_required'
  ) then
    alter table messages
      add constraint messages_chat_room_sequence_required
      check ((kind = 'chat') = (chat_room_sequence is not null));
  end if;
end
$$;

alter table chat_read_receipts
  add column if not exists last_read_sequence bigint;

-- Repair receipts created by the old unscoped write before deriving positions.
update chat_read_receipts receipt
set last_read_message_id = null,
    last_read_sequence = null
where receipt.last_read_message_id is not null
  and not exists (
    select 1
    from messages message
    where message.id = receipt.last_read_message_id
      and message.org_id = receipt.org_id
      and message.thread_id = receipt.thread_id
      and message.kind = 'chat'
  );

update chat_read_receipts receipt
set last_read_sequence = message.chat_room_sequence
from messages message
where message.id = receipt.last_read_message_id
  and message.org_id = receipt.org_id
  and message.thread_id = receipt.thread_id
  and message.kind = 'chat';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chat_read_receipts_sequence_positive'
  ) then
    alter table chat_read_receipts
      add constraint chat_read_receipts_sequence_positive
      check (last_read_sequence is null or last_read_sequence > 0);
  end if;
end
$$;
