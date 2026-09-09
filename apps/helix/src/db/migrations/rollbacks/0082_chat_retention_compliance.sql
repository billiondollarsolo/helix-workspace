-- Guarded rollback: tombstone metadata must be archived before enforcement is
-- removed. Deleted message bodies were intentionally erased and cannot be
-- recreated by rollback.

do $$
begin
  if exists (
    select 1 from messages
    where kind = 'chat' and tombstoned_at is not null
  ) then
    raise exception
      'refusing 0082 rollback: archive Chat tombstone metadata before removing compliance columns';
  end if;
end
$$;

drop trigger if exists messages_enforce_chat_tombstone on messages;
drop function if exists helix_enforce_chat_tombstone();
drop index if exists chat_message_client_retry_unique;

alter table chat_retention_policies
  drop constraint if exists chat_retention_policy_actor_org_fk,
  drop constraint if exists chat_retention_policy_thread_org_fk;

drop index if exists chat_retention_room_override_unique;
drop index if exists chat_retention_org_default_unique;
drop table if exists chat_retention_policies;

alter table messages
  drop constraint if exists messages_chat_tombstone_reason_check,
  drop column if exists tombstone_reason,
  drop column if exists tombstoned_at;
