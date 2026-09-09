-- Rollback removes enforcement only. Duplicate membership rows deleted by the
-- forward migration are intentionally not recreated.

alter table chat_read_receipts
  drop constraint if exists chat_read_receipts_message_room_org_fk,
  drop constraint if exists chat_read_receipts_actor_org_fk,
  drop constraint if exists chat_read_receipts_room_org_fk;

alter table chat_pins
  drop constraint if exists chat_pins_actor_org_fk,
  drop constraint if exists chat_pins_message_room_org_fk;

alter table chat_reactions
  drop constraint if exists chat_reactions_actor_org_fk,
  drop constraint if exists chat_reactions_message_org_fk;

alter table chat_room_settings
  drop constraint if exists chat_room_settings_thread_org_fk;

alter table permissions
  drop constraint if exists permissions_chat_grantor_org_fk,
  drop constraint if exists permissions_chat_actor_org_fk;

drop index if exists chat_thread_membership_unique;
drop index if exists chat_messages_org_thread_id_unique;
drop index if exists chat_messages_org_id_unique;
drop index if exists chat_threads_org_id_unique;
drop index if exists chat_actors_org_id_unique;
