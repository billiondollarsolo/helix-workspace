-- Chat tenant integrity and one canonical membership row per actor/room.
--
-- Composite foreign keys are NOT VALID intentionally: they enforce every new
-- write immediately while allowing production rollout before historical data
-- is audited and validated in a separate maintenance window.

create unique index if not exists chat_actors_org_id_unique
  on actors (org_id, id);
create unique index if not exists chat_threads_org_id_unique
  on threads (org_id, id);
create unique index if not exists chat_messages_org_id_unique
  on messages (org_id, id);
create unique index if not exists chat_messages_org_thread_id_unique
  on messages (org_id, thread_id, id);

-- Preserve the strongest/latest live membership before adding the uniqueness
-- invariant used by the store's conflict-safe invite/upsert.
with ranked as (
  select
    id,
    row_number() over (
      partition by org_id, resource_id, actor_id
      order by
        case role when 'owner' then 0 when 'admin' then 1 else 2 end,
        (expires_at is null) desc,
        updated_at desc,
        id desc
    ) as position
  from permissions
  where resource_type = 'thread'
)
delete from permissions
where id in (select id from ranked where position > 1);

create unique index if not exists chat_thread_membership_unique
  on permissions (org_id, resource_id, actor_id)
  where resource_type = 'thread';

alter table permissions
  add constraint permissions_chat_actor_org_fk
    foreign key (org_id, actor_id)
    references actors (org_id, id)
    not valid,
  add constraint permissions_chat_grantor_org_fk
    foreign key (org_id, granted_by_actor_id)
    references actors (org_id, id)
    not valid;

alter table chat_room_settings
  add constraint chat_room_settings_thread_org_fk
    foreign key (org_id, thread_id)
    references threads (org_id, id)
    on delete cascade
    not valid;

alter table chat_reactions
  add constraint chat_reactions_message_org_fk
    foreign key (org_id, message_id)
    references messages (org_id, id)
    on delete cascade
    not valid,
  add constraint chat_reactions_actor_org_fk
    foreign key (org_id, actor_id)
    references actors (org_id, id)
    on delete cascade
    not valid;

alter table chat_pins
  add constraint chat_pins_message_room_org_fk
    foreign key (org_id, thread_id, message_id)
    references messages (org_id, thread_id, id)
    on delete cascade
    not valid,
  add constraint chat_pins_actor_org_fk
    foreign key (org_id, pinned_by_actor_id)
    references actors (org_id, id)
    not valid;

alter table chat_read_receipts
  add constraint chat_read_receipts_room_org_fk
    foreign key (org_id, thread_id)
    references threads (org_id, id)
    on delete cascade
    not valid,
  add constraint chat_read_receipts_actor_org_fk
    foreign key (org_id, actor_id)
    references actors (org_id, id)
    on delete cascade
    not valid,
  add constraint chat_read_receipts_message_room_org_fk
    foreign key (org_id, thread_id, last_read_message_id)
    references messages (org_id, thread_id, id)
    not valid;
