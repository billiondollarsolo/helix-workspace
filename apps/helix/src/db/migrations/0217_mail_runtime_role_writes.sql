-- Two Mail write paths failed under the RLS-constrained runtime role (helix_app)
-- and only worked for a privileged session.
--
-- 1. Inbound mail evidence. persistRawSource inserts the `mail_source` object
--    with RETURNING, so the new row must pass the read policy too. The read
--    rule only allowed readers of the message, and the mail_raw_sources row is
--    inserted afterwards, so every inbound message failed with "new row
--    violates row-level security policy for table objects". The mail service
--    context (no acting user) may already write these objects; it may now read
--    them as well.
--
-- 2. Attachments on sent mail. The active-object check on message_attachments
--    is an integrity rule, not an authorization rule, but it ran with the
--    caller's row policies; a sender's new message is not yet readable while
--    its attachments are linked (mailbox state is written afterwards), so
--    sending mail with an attachment failed with "message attachments require
--    an active Drive object".

create or replace function helix_can_read_mail_object(
  object_org_id uuid,
  object_id uuid,
  object_kind text,
  owner_actor_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select case object_kind
    when 'mail_attachment' then
      public.helix_mail_service_context(object_org_id)
      or (
        exists (
          select 1 from public.mail_attachment_ingestions stage
          where stage.org_id = object_org_id and stage.object_id = $2
            and stage.status in ('clean', 'attached') and stage.cleaned_at is null
        )
        and (
          owner_actor_id = public.helix_current_actor_id()
          or exists (
            select 1 from public.message_attachments attachment
            where attachment.org_id = object_org_id and attachment.object_id = $2
              and public.helix_can_read_message_attachment(
                attachment.org_id, attachment.message_id
              )
          )
        )
      )
    when 'mail_source' then
      public.helix_mail_service_context(object_org_id)
      or exists (
        select 1 from public.mail_raw_sources source
        where source.org_id = object_org_id and source.object_id = $2
          and public.helix_can_read_mail_message(source.org_id, source.message_id)
      )
    when 'chat_attachment' then
      public.helix_can_read_chat_attachment(object_org_id, $2)
      or (
        owner_actor_id = public.helix_current_actor_id()
        and exists (
          select 1 from public.chat_attachments attachment
          where attachment.org_id = object_org_id and attachment.object_id = $2
            and attachment.owner_actor_id = public.helix_current_actor_id()
            and attachment.message_id is null
            and attachment.expires_at > statement_timestamp()
            and public.helix_chat_attachment_room_access(
              attachment.org_id, public.helix_current_actor_id(), attachment.room_id
            )
        )
      )
    else true
  end
$$;

create or replace function helix_require_active_message_attachment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  if not exists (
    select 1
    from public.objects o
    join public.messages m on m.id = new.message_id
    where o.id = new.object_id
      and o.org_id = m.org_id
      and o.org_id = new.org_id
      and o.upload_state = 'active'
      and o.deleted_at is null
  ) then
    raise exception 'message attachments require an active Drive object'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

alter function helix_require_active_message_attachment() owner to helix_migration_owner;
revoke all on function helix_require_active_message_attachment() from public;
