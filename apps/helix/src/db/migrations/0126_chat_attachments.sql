alter type object_kind add value if not exists 'chat_attachment';

create table chat_attachments (
  object_id uuid primary key,
  org_id uuid not null,
  room_id uuid not null,
  owner_actor_id uuid not null,
  message_id uuid,
  filename text not null check (char_length(filename) between 1 and 255),
  mime_type text not null check (mime_type in (
    'image/png', 'image/jpeg', 'image/gif', 'image/webp'
  )),
  byte_size bigint not null check (byte_size between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('staging', 'ready', 'rejected', 'purged')),
  failure_reason text,
  scanned_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, object_id),
  foreign key (org_id, object_id) references objects(org_id, id) on delete cascade,
  foreign key (org_id, room_id) references threads(org_id, id) on delete cascade,
  foreign key (org_id, owner_actor_id) references actors(org_id, id) on delete restrict,
  foreign key (org_id, message_id) references messages(org_id, id) on delete cascade,
  constraint chat_attachments_state_check check (
    (status = 'staging' and message_id is null and failure_reason is null)
    or (status = 'ready' and failure_reason is null)
    or (status in ('rejected', 'purged') and message_id is null
      and char_length(btrim(failure_reason)) > 0)
  )
);

create index chat_attachments_room_message_idx
  on chat_attachments (org_id, room_id, message_id, created_at);
create index chat_attachments_expiry_idx
  on chat_attachments (expires_at, object_id)
  where message_id is null and status in ('staging', 'ready');

-- One authorization predicate is shared by RLS, object visibility, routes,
-- and attachment binding. Revoked/banned members therefore lose media at the
-- same boundary as messages and realtime replay.
create function helix_chat_attachment_room_access(
  input_org_id uuid,
  input_actor_id uuid,
  input_room_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select
    input_org_id = public.helix_current_org_id()
    and input_actor_id = public.helix_current_actor_id()
    and exists (
      select 1
      from public.threads room
      join public.permissions permission
        on permission.org_id = room.org_id
       and permission.resource_type = 'thread'
       and permission.resource_id = room.id
      where room.org_id = input_org_id
        and room.id = input_room_id
        and room.kind in ('chat_room', 'chat_dm')
        and public.chat_permission_is_valid(
          permission, input_org_id, input_actor_id, input_room_id
        )
    )
    and not exists (
      select 1 from public.chat_room_bans ban
      where ban.org_id = input_org_id
        and ban.room_id = input_room_id
        and ban.actor_id = input_actor_id
        and ban.revoked_at is null
        and (ban.expires_at is null or ban.expires_at > statement_timestamp())
    )
$$;

create function helix_can_read_chat_attachment(input_org_id uuid, input_object_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select exists (
    select 1 from public.chat_attachments attachment
    where attachment.org_id = input_org_id
      and attachment.object_id = input_object_id
      and attachment.status = 'ready'
      and public.helix_chat_attachment_room_access(
        attachment.org_id,
        public.helix_current_actor_id(),
        attachment.room_id
      )
      and (
        attachment.message_id is not null
        or (
          attachment.owner_actor_id = public.helix_current_actor_id()
          and attachment.expires_at > statement_timestamp()
        )
      )
  )
$$;

create function helix_can_write_chat_attachment_object(
  input_org_id uuid,
  input_object_id uuid,
  input_owner_actor_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select input_owner_actor_id = public.helix_current_actor_id()
    and (
      not exists (
        select 1 from public.chat_attachments attachment
        where attachment.org_id = input_org_id and attachment.object_id = input_object_id
      )
      or exists (
        select 1 from public.chat_attachments attachment
        where attachment.org_id = input_org_id
          and attachment.object_id = input_object_id
          and attachment.owner_actor_id = public.helix_current_actor_id()
          and attachment.message_id is null
          and attachment.expires_at > statement_timestamp()
          and public.helix_chat_attachment_room_access(
            attachment.org_id,
            public.helix_current_actor_id(),
            attachment.room_id
          )
      )
    )
$$;

alter table chat_attachments enable row level security;
alter table chat_attachments force row level security;
create policy helix_tenant_isolation on chat_attachments
  using (
    org_id = helix_current_org_id()
    and helix_chat_attachment_room_access(org_id, helix_current_actor_id(), room_id)
    and (
      (status = 'ready' and message_id is not null)
      or (
        owner_actor_id = helix_current_actor_id()
        and message_id is null
        and expires_at > statement_timestamp()
      )
    )
  )
  with check (
    org_id = helix_current_org_id()
    and owner_actor_id = helix_current_actor_id()
    and message_id is null
    and expires_at > statement_timestamp()
    and helix_chat_attachment_room_access(org_id, helix_current_actor_id(), room_id)
  );

-- Close the historical `else true` attachment shortcut for Chat while
-- retaining the mail and recording/system behavior already in production.
create or replace function helix_can_read_message_attachment(
  attachment_org_id uuid,
  attachment_message_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select coalesce((
    select case
      when message.kind = 'mail'
        then public.helix_can_read_mail_message(message.org_id, message.id)
      when message.kind = 'chat'
        then public.helix_chat_attachment_room_access(
          message.org_id, public.helix_current_actor_id(), message.thread_id
        )
      else true
    end
    from public.messages message
    where message.org_id = attachment_org_id
      and message.id = attachment_message_id
  ), false)
$$;

create or replace function helix_can_write_message_attachment(
  attachment_org_id uuid,
  attachment_message_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select coalesce((
    select case
      when message.kind = 'mail'
        then public.helix_can_write_mail_thread(message.org_id, message.thread_id)
      when message.kind = 'chat'
        then message.actor_id = public.helix_current_actor_id()
          and public.helix_chat_attachment_room_access(
            message.org_id, public.helix_current_actor_id(), message.thread_id
          )
      else true
    end
    from public.messages message
    where message.org_id = attachment_org_id
      and message.id = attachment_message_id
  ), false)
$$;

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
    when 'mail_source' then exists (
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

create or replace function helix_can_write_mail_object(
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
      or owner_actor_id = public.helix_current_actor_id()
      or exists (
        select 1 from public.message_attachments attachment
        where attachment.org_id = object_org_id
          and attachment.object_id = $2
          and public.helix_can_write_message_attachment(
            attachment.org_id, attachment.message_id
          )
      )
    when 'mail_source' then public.helix_mail_service_context(object_org_id)
    when 'chat_attachment' then
      public.helix_can_write_chat_attachment_object(object_org_id, $2, owner_actor_id)
    else true
  end
$$;

create function helix_bind_chat_message_attachment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  target_message public.messages%rowtype;
  target_object public.objects%rowtype;
begin
  select * into target_message from public.messages message
  where message.org_id = new.org_id and message.id = new.message_id;
  if not found or target_message.kind <> 'chat' then return new; end if;

  select * into target_object from public.objects object
  where object.org_id = new.org_id and object.id = new.object_id
    and object.deleted_at is null;
  if not found then raise check_violation using message = 'chat attachment object is unavailable'; end if;

  if target_object.kind::text = 'chat_attachment' then
    update public.chat_attachments attachment set
      message_id = new.message_id,
      expires_at = 'infinity',
      updated_at = now()
    where attachment.org_id = new.org_id
      and attachment.object_id = new.object_id
      and attachment.room_id = target_message.thread_id
      and attachment.owner_actor_id = public.helix_current_actor_id()
      and target_message.actor_id = public.helix_current_actor_id()
      and attachment.status = 'ready'
      and attachment.message_id is null
      and attachment.expires_at > statement_timestamp()
      and exists (
        select 1 from public.drive_quarantine_deletions deletion
        where deletion.org_id = attachment.org_id
          and deletion.object_id = attachment.object_id
          and deletion.storage_key = target_object.storage_key
          and deletion.status = 'pending'
          and deletion.next_attempt_at > statement_timestamp()
      );
    if not found then
      raise check_violation using message = 'chat attachment is not ready, owned, or room-scoped';
    end if;
    delete from public.drive_quarantine_deletions deletion
    where deletion.org_id = new.org_id
      and deletion.object_id = new.object_id
      and deletion.storage_key = target_object.storage_key;
  elsif target_object.kind::text in ('file', 'recording') then
    if target_object.owner_actor_id is distinct from public.helix_current_actor_id()
      and not exists (
        select 1 from public.permissions permission
        where permission.org_id = new.org_id
          and permission.actor_id = public.helix_current_actor_id()
          and permission.resource_type = 'object'
          and permission.resource_id = new.object_id
          and permission.role in ('owner', 'editor', 'commenter', 'reader')
          and permission.status = 'active'
          and permission.valid_from <= statement_timestamp()
          and (permission.expires_at is null or permission.expires_at > statement_timestamp())
          and permission.revoked_at is null
          and permission.revocation_epoch = 0
      )
    then
      raise insufficient_privilege using message = 'Drive attachment is inaccessible';
    end if;
  else
    raise check_violation using message = 'unsupported chat attachment object kind';
  end if;
  return new;
end
$$;

create trigger message_attachments_bind_chat_object
before insert on message_attachments
for each row execute function helix_bind_chat_message_attachment();

-- The existing quarantine deletion worker is also the byte-purge worker for
-- hidden Chat media. Unsent stages are scheduled at creation; a hard-retained
-- message purge cascades here and immediately schedules the same durable job.
create function helix_queue_deleted_chat_attachment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  object_storage_key text;
begin
  select storage_key into object_storage_key from public.objects
  where org_id = old.org_id and id = old.object_id;
  if object_storage_key is not null then
    insert into public.drive_quarantine_deletions (
      org_id, object_id, actor_id, storage_key, status, next_attempt_at
    ) values (
      old.org_id, old.object_id, old.owner_actor_id, object_storage_key, 'pending', now()
    )
    on conflict (org_id, storage_key) do update set
      object_id = excluded.object_id,
      actor_id = excluded.actor_id,
      status = 'pending',
      next_attempt_at = now(),
      lease_expires_at = null,
      completed_at = null,
      updated_at = now();
  end if;
  return old;
end
$$;

create trigger chat_attachments_queue_byte_purge
after delete on chat_attachments
for each row execute function helix_queue_deleted_chat_attachment();

create function helix_finish_chat_attachment_purge()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  update public.chat_attachments attachment set
    status = 'purged',
    failure_reason = coalesce(attachment.failure_reason, 'Attachment bytes purged.'),
    updated_at = now()
  where attachment.org_id = new.org_id
    and attachment.object_id = new.object_id
    and attachment.message_id is null;
  update public.objects object set deleted_at = coalesce(object.deleted_at, now()), updated_at = now()
  where object.org_id = new.org_id
    and object.id = new.object_id
    and object.kind::text = 'chat_attachment'
    and not exists (
      select 1 from public.chat_attachments attachment
      where attachment.org_id = object.org_id
        and attachment.object_id = object.id
        and attachment.message_id is not null
    );
  return new;
end
$$;

create trigger drive_quarantine_deletions_finish_chat_purge
after update of status on drive_quarantine_deletions
for each row
when (old.status is distinct from new.status and new.status = 'completed')
execute function helix_finish_chat_attachment_purge();

-- Quota reads need the whole tenant even though hidden Chat objects are not
-- visible outside their room. Keep that bypass in one tenant-checked function.
create function helix_storage_usage_bytes(input_org_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  result bigint;
begin
  if input_org_id is distinct from public.helix_current_org_id() then
    raise insufficient_privilege using message = 'storage quota tenant mismatch';
  end if;
  select coalesce(sum(stored.byte_size), 0)::bigint into result
  from (
    select source.storage_key, max(source.byte_size)::bigint as byte_size
    from (
      select object.storage_key, object.byte_size
      from public.objects object
      where object.org_id = input_org_id
        and object.deleted_at is null
        and (
          (object.kind::text in ('file', 'recording')
            and coalesce(object.metadata->>'status', 'ready') = 'ready')
          or object.kind::text = 'chat_attachment'
        )
      union all
      select version.storage_key, version.byte_size
      from public.drive_versions version
      join public.objects object
        on object.org_id = version.org_id and object.id = version.object_id
      where version.org_id = input_org_id
        and object.kind::text in ('file', 'recording')
        and object.deleted_at is null
        and coalesce(object.metadata->>'status', 'ready') = 'ready'
    ) source
    group by source.storage_key
  ) stored;
  return result;
end
$$;

revoke all on chat_attachments from public, helix_readonly;
revoke insert, update, delete, truncate on chat_attachments from helix_worker;
grant select, insert, update, delete on chat_attachments to helix_app;
grant select on chat_attachments to helix_worker;

revoke all on function helix_chat_attachment_room_access(uuid, uuid, uuid) from public;
revoke all on function helix_can_read_chat_attachment(uuid, uuid) from public;
revoke all on function helix_can_write_chat_attachment_object(uuid, uuid, uuid) from public;
revoke all on function helix_storage_usage_bytes(uuid) from public;
grant execute on function helix_chat_attachment_room_access(uuid, uuid, uuid) to helix_app, helix_worker;
grant execute on function helix_can_read_chat_attachment(uuid, uuid) to helix_app, helix_worker;
grant execute on function helix_can_write_chat_attachment_object(uuid, uuid, uuid) to helix_app, helix_worker;
grant execute on function helix_storage_usage_bytes(uuid) to helix_app, helix_worker;
