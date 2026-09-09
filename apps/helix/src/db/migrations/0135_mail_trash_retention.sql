alter table mail_thread_state
  add column trash_purge_after timestamptz;

update mail_thread_state
set trash_purge_after = deleted_at + interval '30 days'
where deleted_at is not null;

alter table mail_thread_state
  add constraint mail_thread_state_trash_deadline_check check (
    (deleted_at is null and trash_purge_after is null)
    or (deleted_at is not null and trash_purge_after is not null)
  );

create index mail_thread_state_trash_purge_idx
  on mail_thread_state (trash_purge_after, org_id, actor_id, thread_id)
  where trash_purge_after is not null;

create function helix_set_mail_trash_deadline()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.deleted_at is null then
    new.trash_purge_after := null;
  elsif tg_op = 'INSERT' or old.deleted_at is null then
    new.trash_purge_after := new.deleted_at + interval '30 days';
  else
    new.deleted_at := old.deleted_at;
    new.trash_purge_after := old.trash_purge_after;
  end if;
  return new;
end
$$;

create trigger mail_thread_state_set_trash_deadline
before insert or update of deleted_at, trash_purge_after on mail_thread_state
for each row execute function helix_set_mail_trash_deadline();

create table mail_retention_holds (
  org_id uuid not null,
  thread_id uuid not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  expires_at timestamptz,
  created_by_actor_id uuid,
  created_at timestamptz not null default now(),
  primary key (org_id, thread_id),
  foreign key (org_id, thread_id) references threads (org_id, id) on delete cascade,
  foreign key (org_id, created_by_actor_id) references actors (org_id, id) on delete restrict
);

create index mail_retention_holds_expiry_idx
  on mail_retention_holds (expires_at, org_id, thread_id);

alter table mail_retention_holds enable row level security;
alter table mail_retention_holds force row level security;
create policy helix_tenant_isolation on mail_retention_holds
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

revoke all on mail_retention_holds from public, helix_readonly;
grant select on mail_retention_holds to helix_app, helix_worker, helix_readonly;
grant insert, update, delete on mail_retention_holds to helix_worker;

-- Preserve the quarantine resolution audit after its released mailbox content
-- reaches the end of retention.
alter table mail_quarantines
  add column released_message_purged_at timestamptz;
alter table mail_suppressions
  add column source_event_purged_at timestamptz,
  add constraint mail_suppressions_source_event_purge_check check (
    source_event_id is null or source_event_purged_at is null
  );
alter table mail_quarantines
  drop constraint mail_quarantines_resolution_check;
alter table mail_quarantines
  add constraint mail_quarantines_resolution_check check (
    (status = 'pending'
      and release_token is null
      and release_lease_expires_at is null
      and released_message_id is null
      and released_message_purged_at is null
      and resolved_by_actor_id is null
      and resolution_reason is null
      and resolved_at is null)
    or (status = 'rechecking'
      and release_token is not null
      and release_lease_expires_at is not null
      and released_message_id is null
      and released_message_purged_at is null
      and resolved_by_actor_id is null
      and resolution_reason is null
      and resolved_at is null)
    or (status = 'released'
      and release_token is null
      and release_lease_expires_at is null
      and ((released_message_id is not null and released_message_purged_at is null)
        or (released_message_id is null and released_message_purged_at is not null))
      and resolved_by_actor_id is not null
      and resolution_reason is not null
      and resolved_at is not null)
    or (status = 'deleted'
      and release_token is null
      and release_lease_expires_at is null
      and released_message_id is null
      and released_message_purged_at is null
      and resolved_by_actor_id is not null
      and resolution_reason is not null
      and resolved_at is not null)
  );

-- A message is readable only through a mailbox state row. This makes purging a
-- mailbox row revoke direct sender access while preserving other mailboxes.
create or replace function helix_can_read_mail_message(
  mailbox_org_id uuid,
  mailbox_message_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    public.helix_mail_service_context(mailbox_org_id)
    or exists (
      select 1
      from public.messages message
      where message.org_id = mailbox_org_id
        and message.id = mailbox_message_id
        and message.kind = 'mail'
        and public.helix_can_read_mail_thread(message.org_id, message.thread_id)
    )
$$;

create function helix_purge_expired_mail_trash(
  batch_limit integer,
  due_before timestamptz
)
returns table (
  purged_mailboxes integer,
  purged_threads integer,
  queued_objects integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  due_mailbox record;
  mail_object record;
begin
  if batch_limit not between 1 and 500 then
    raise exception 'invalid mail trash purge batch size';
  end if;
  if nullif(current_setting('helix.org_id', true), '') is not null
    or nullif(current_setting('helix.actor_id', true), '') is not null
  then
    raise insufficient_privilege using
      message = 'mail trash purge requires an unscoped worker context';
  end if;

  purged_mailboxes := 0;
  purged_threads := 0;
  queued_objects := 0;

  for due_mailbox in
    select state.org_id, state.actor_id, state.thread_id
    from public.mail_thread_state state
    where state.trash_purge_after <= due_before
      and not exists (
        select 1 from public.mail_retention_holds hold
        where hold.org_id = state.org_id and hold.thread_id = state.thread_id
          and (hold.expires_at is null or hold.expires_at > due_before)
      )
      and not exists (
        select 1 from public.mail_outbound_messages outbound
        where outbound.org_id = state.org_id and outbound.thread_id = state.thread_id
          and outbound.status in ('queued', 'sending')
      )
    order by state.trash_purge_after, state.org_id, state.actor_id, state.thread_id
    limit batch_limit
    for update of state skip locked
  loop
    perform 1 from public.threads thread
    where thread.org_id = due_mailbox.org_id and thread.id = due_mailbox.thread_id
    for update;
    if not found or exists (
      select 1 from public.mail_retention_holds hold
      where hold.org_id = due_mailbox.org_id and hold.thread_id = due_mailbox.thread_id
        and (hold.expires_at is null or hold.expires_at > due_before)
    ) then
      continue;
    end if;

    delete from public.mail_message_deliveries delivery
    using public.messages message
    where delivery.org_id = due_mailbox.org_id
      and delivery.actor_id = due_mailbox.actor_id
      and message.org_id = delivery.org_id
      and message.id = delivery.message_id
      and message.thread_id = due_mailbox.thread_id;

    delete from public.mail_thread_state state
    where state.org_id = due_mailbox.org_id
      and state.actor_id = due_mailbox.actor_id
      and state.thread_id = due_mailbox.thread_id;
    if not found then
      continue;
    end if;
    purged_mailboxes := purged_mailboxes + 1;

    -- Canonical content remains while any mailbox state or delivery can still
    -- expose the thread to another mailbox.
    if exists (
      select 1 from public.mail_thread_state state
      where state.org_id = due_mailbox.org_id and state.thread_id = due_mailbox.thread_id
    ) or exists (
      select 1
      from public.mail_message_deliveries delivery
      join public.messages message
        on message.org_id = delivery.org_id and message.id = delivery.message_id
      where delivery.org_id = due_mailbox.org_id
        and message.thread_id = due_mailbox.thread_id
    ) then
      continue;
    end if;

    -- Queue only mail-owned blobs. Drive files attached to a message remain in
    -- Drive, and an object with any surviving reference is never queued.
    for mail_object in
      select distinct object.id, object.owner_actor_id, object.storage_key, object.kind::text as kind
      from public.objects object
      where object.org_id = due_mailbox.org_id
        and object.kind::text in ('mail_attachment', 'mail_source')
        and (
          exists (
            select 1
            from public.message_attachments attachment
            join public.messages message
              on message.org_id = attachment.org_id and message.id = attachment.message_id
            where attachment.org_id = object.org_id
              and attachment.object_id = object.id
              and message.thread_id = due_mailbox.thread_id
          )
          or exists (
            select 1
            from public.mail_raw_sources source
            join public.messages message
              on message.org_id = source.org_id and message.id = source.message_id
            where source.org_id = object.org_id
              and source.object_id = object.id
              and message.thread_id = due_mailbox.thread_id
          )
          or exists (
            select 1
            from public.mail_attachment_ingestions stage
            join public.messages message
              on message.org_id = stage.org_id and message.id = stage.message_id
            where stage.org_id = object.org_id
              and stage.object_id = object.id
              and message.thread_id = due_mailbox.thread_id
          )
        )
    loop
      delete from public.message_attachments attachment
      using public.messages message
      where attachment.org_id = due_mailbox.org_id
        and attachment.object_id = mail_object.id
        and message.org_id = attachment.org_id
        and message.id = attachment.message_id
        and message.thread_id = due_mailbox.thread_id;
      delete from public.mail_raw_sources source
      using public.messages message
      where source.org_id = due_mailbox.org_id
        and source.object_id = mail_object.id
        and message.org_id = source.org_id
        and message.id = source.message_id
        and message.thread_id = due_mailbox.thread_id;

      if not exists (
        select 1 from public.message_attachments attachment
        where attachment.org_id = due_mailbox.org_id and attachment.object_id = mail_object.id
      ) and not exists (
        select 1 from public.mail_raw_sources source
        where source.org_id = due_mailbox.org_id and source.object_id = mail_object.id
      ) then
        delete from public.mail_attachment_ingestions stage
        where stage.org_id = due_mailbox.org_id and stage.object_id = mail_object.id;
        insert into public.drive_quarantine_deletions (
          org_id, object_id, actor_id, storage_key
        ) values (
          due_mailbox.org_id, mail_object.id, mail_object.owner_actor_id, mail_object.storage_key
        )
        on conflict (org_id, storage_key) do update set
          object_id = excluded.object_id,
          actor_id = coalesce(excluded.actor_id, drive_quarantine_deletions.actor_id),
          status = 'pending',
          next_attempt_at = now(),
          lease_expires_at = null,
          completed_at = null,
          last_error = null,
          updated_at = now();
        delete from public.permissions permission
        where permission.org_id = due_mailbox.org_id
          and permission.resource_type = 'object'
          and permission.resource_id = mail_object.id;
        delete from public.objects object
        where object.org_id = due_mailbox.org_id and object.id = mail_object.id;
        queued_objects := queued_objects + 1;
      end if;
    end loop;

    update public.mail_quarantines quarantine
    set released_message_id = null, released_message_purged_at = now()
    where quarantine.org_id = due_mailbox.org_id
      and quarantine.status = 'released'
      and exists (
        select 1 from public.messages message
        where message.org_id = quarantine.org_id
          and message.id = quarantine.released_message_id
          and message.thread_id = due_mailbox.thread_id
      );
    delete from public.mail_vacation_responses response
    where response.org_id = due_mailbox.org_id
      and (response.thread_id = due_mailbox.thread_id or exists (
        select 1 from public.messages message
        where message.org_id = response.org_id
          and message.id = response.message_id
          and message.thread_id = due_mailbox.thread_id
      ));
    update public.mail_suppressions suppression
    set source_event_id = null, source_event_purged_at = now()
    where suppression.org_id = due_mailbox.org_id
      and exists (
        select 1
        from public.mail_delivery_events event
        join public.mail_outbound_messages outbound
          on outbound.org_id = event.org_id and outbound.id = event.outbound_id
        where event.org_id = suppression.org_id
          and event.id = suppression.source_event_id
          and outbound.thread_id = due_mailbox.thread_id
      );
    delete from public.mail_outbound_messages outbound
    where outbound.org_id = due_mailbox.org_id and outbound.thread_id = due_mailbox.thread_id;
    delete from public.permissions permission
    where permission.org_id = due_mailbox.org_id
      and permission.resource_type = 'message'
      and exists (
        select 1 from public.messages message
        where message.org_id = permission.org_id
          and message.id = permission.resource_id
          and message.thread_id = due_mailbox.thread_id
      );
    delete from public.messages message
    where message.org_id = due_mailbox.org_id and message.thread_id = due_mailbox.thread_id;
    delete from public.permissions permission
    where permission.org_id = due_mailbox.org_id
      and permission.resource_type = 'thread'
      and permission.resource_id = due_mailbox.thread_id;
    delete from public.threads thread
    where thread.org_id = due_mailbox.org_id and thread.id = due_mailbox.thread_id;
    purged_threads := purged_threads + 1;
  end loop;

  return next;
end
$$;

alter function helix_set_mail_trash_deadline() owner to helix_migration_owner;
alter table mail_retention_holds owner to helix_migration_owner;
alter function helix_can_read_mail_message(uuid, uuid) owner to helix_migration_owner;
alter function helix_purge_expired_mail_trash(integer, timestamptz)
  owner to helix_migration_owner;

revoke all on function helix_purge_expired_mail_trash(integer, timestamptz)
  from public, helix_readonly;
grant execute on function helix_purge_expired_mail_trash(integer, timestamptz)
  to helix_app, helix_worker;
