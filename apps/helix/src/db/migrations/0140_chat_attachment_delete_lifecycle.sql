-- A Chat tombstone immediately revokes media access and hands the private
-- object to the existing durable deletion worker. The message row and audit
-- history remain available to future retention/hold policy.

create or replace function helix_can_read_chat_attachment(input_org_id uuid, input_object_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select exists (
    select 1
    from public.chat_attachments attachment
    left join public.messages message
      on message.org_id = attachment.org_id
     and message.id = attachment.message_id
     and message.kind = 'chat'
    where attachment.org_id = input_org_id
      and attachment.object_id = input_object_id
      and attachment.status = 'ready'
      and public.helix_chat_attachment_room_access(
        attachment.org_id,
        public.helix_current_actor_id(),
        attachment.room_id
      )
      and (
        (attachment.message_id is not null and message.deleted_at is null)
        or (
          attachment.message_id is null
          and attachment.owner_actor_id = public.helix_current_actor_id()
          and attachment.expires_at > statement_timestamp()
        )
      )
  )
$$;

create function helix_revoke_deleted_chat_attachments()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null and new.kind = 'chat' then
    delete from public.chat_attachments attachment
    where attachment.org_id = new.org_id
      and attachment.message_id = new.id;
  end if;
  return new;
end
$$;

create trigger messages_revoke_deleted_chat_attachments
after update of deleted_at on messages
for each row execute function helix_revoke_deleted_chat_attachments();
