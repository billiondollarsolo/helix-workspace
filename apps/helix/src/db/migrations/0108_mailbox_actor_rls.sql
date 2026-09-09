-- Mail content is canonical and immutable, while visibility belongs to each
-- recipient mailbox.  These predicates make that boundary structural: an
-- unfiltered query under the runtime role can see only the authenticated
-- actor's mailbox (or a currently delegated mailbox).

alter table message_attachments add column if not exists org_id uuid;

update message_attachments attachment
set org_id = message.org_id
from messages message, objects object
where message.id = attachment.message_id
  and object.id = attachment.object_id
  and message.org_id = object.org_id
  and attachment.org_id is null;

do $$
begin
  if exists (select 1 from message_attachments where org_id is null) then
    raise exception 'cross-tenant or orphaned message attachment exists';
  end if;
end
$$;

alter table message_attachments alter column org_id set not null;
alter table message_attachments
  drop constraint if exists message_attachments_message_id_fkey,
  drop constraint if exists message_attachments_object_id_fkey;
alter table message_attachments
  add constraint message_attachments_message_org_fk
    foreign key (org_id, message_id) references messages (org_id, id) on delete cascade,
  add constraint message_attachments_object_org_fk
    foreign key (org_id, object_id) references objects (org_id, id) on delete cascade;
create index if not exists message_attachments_org_object_idx
  on message_attachments (org_id, object_id);

create or replace function helix_mail_service_context(expected_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    expected_org_id = public.helix_current_org_id()
    and (
      public.helix_current_actor_id() is null
      or exists (
        select 1
        from public.actors actor
        where actor.org_id = expected_org_id
          and actor.id = public.helix_current_actor_id()
          and actor.type in ('service_account', 'system')
          and actor.disabled_at is null
      )
    )
$$;

create or replace function helix_can_access_mailbox(
  mailbox_org_id uuid,
  mailbox_actor_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    mailbox_org_id = public.helix_current_org_id()
    and exists (
      select 1
      from public.actors mailbox
      where mailbox.org_id = mailbox_org_id
        and mailbox.id = mailbox_actor_id
        and mailbox.disabled_at is null
    )
    and (
      public.helix_mail_service_context(mailbox_org_id)
      or mailbox_actor_id = public.helix_current_actor_id()
      or exists (
        select 1
        from public.permissions permission
        join public.actors delegate
          on delegate.org_id = permission.org_id
         and delegate.id = permission.actor_id
         and delegate.disabled_at is null
        where permission.org_id = mailbox_org_id
          and permission.actor_id = public.helix_current_actor_id()
          and permission.resource_type = 'mailbox'
          and permission.resource_id = mailbox_actor_id
          and permission.role = 'manager'
          and permission.status = 'active'
          and permission.valid_from <= statement_timestamp()
          and (permission.expires_at is null or permission.expires_at > statement_timestamp())
          and permission.revoked_at is null
          and permission.revocation_epoch = 0
      )
    )
$$;

create or replace function helix_mailbox_owns_thread(
  mailbox_org_id uuid,
  mailbox_actor_id uuid,
  mailbox_thread_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.messages message
    where message.org_id = mailbox_org_id
      and message.thread_id = mailbox_thread_id
      and message.kind = 'mail'
      and (
        message.actor_id = mailbox_actor_id
        or exists (
          select 1
          from public.mail_message_deliveries delivery
          where delivery.org_id = mailbox_org_id
            and delivery.message_id = message.id
            and delivery.actor_id = mailbox_actor_id
        )
      )
  )
$$;

create or replace function helix_can_read_mail_thread(
  mailbox_org_id uuid,
  mailbox_thread_id uuid
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
      from public.mail_thread_state mailbox
      where mailbox.org_id = mailbox_org_id
        and mailbox.thread_id = mailbox_thread_id
        and public.helix_can_access_mailbox(mailbox.org_id, mailbox.actor_id)
    )
$$;

create or replace function helix_can_write_mail_thread(
  mailbox_org_id uuid,
  mailbox_thread_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    public.helix_mail_service_context(mailbox_org_id)
    or public.helix_can_read_mail_thread(mailbox_org_id, mailbox_thread_id)
    or exists (
      select 1
      from public.threads thread
      where thread.org_id = mailbox_org_id
        and thread.id = mailbox_thread_id
        and thread.kind = 'mail'
        and thread.created_by_actor_id = public.helix_current_actor_id()
    )
$$;

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
        and (
          (
            message.actor_id is not null
            and public.helix_can_access_mailbox(message.org_id, message.actor_id)
          )
          or exists (
            select 1
            from public.mail_message_deliveries delivery
            where delivery.org_id = message.org_id
              and delivery.message_id = message.id
              and public.helix_can_access_mailbox(delivery.org_id, delivery.actor_id)
          )
        )
    )
$$;

create or replace function helix_can_write_mail_message(
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
        and public.helix_can_write_mail_thread(message.org_id, message.thread_id)
    )
$$;

create or replace function helix_can_read_message_attachment(
  attachment_org_id uuid,
  attachment_message_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce((
    select case
      when message.kind = 'mail'
        then public.helix_can_read_mail_message(message.org_id, message.id)
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
as $$
  select coalesce((
    select case
      when message.kind = 'mail'
        then public.helix_can_write_mail_thread(message.org_id, message.thread_id)
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
as $$
  select case object_kind
    when 'mail_attachment' then
      public.helix_mail_service_context(object_org_id)
      or owner_actor_id = public.helix_current_actor_id()
      or exists (
        select 1
        from public.message_attachments attachment
        where attachment.org_id = object_org_id
          and attachment.object_id = $2
          and public.helix_can_read_message_attachment(
            attachment.org_id,
            attachment.message_id
          )
      )
    when 'mail_source' then exists (
      select 1
      from public.mail_raw_sources source
      where source.org_id = object_org_id
        and source.object_id = $2
        and public.helix_can_read_mail_message(source.org_id, source.message_id)
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
as $$
  select case object_kind
    when 'mail_attachment' then
      public.helix_mail_service_context(object_org_id)
      or owner_actor_id = public.helix_current_actor_id()
      or exists (
        select 1
        from public.message_attachments attachment
        where attachment.org_id = object_org_id
          and attachment.object_id = $2
          and public.helix_can_write_message_attachment(
            attachment.org_id,
            attachment.message_id
          )
      )
    when 'mail_source' then public.helix_mail_service_context(object_org_id)
    else true
  end
$$;

create or replace function helix_validate_mailbox_permission()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.resource_type <> 'mailbox' then
    return new;
  end if;
  if new.actor_id = new.resource_id
    or new.role <> 'manager'
    or new.granted_by_actor_id is distinct from new.resource_id
    or not exists (
      select 1 from public.actors delegate
      where delegate.org_id = new.org_id
        and delegate.id = new.actor_id
        and delegate.disabled_at is null
    )
    or not exists (
      select 1 from public.actors owner
      where owner.org_id = new.org_id
        and owner.id = new.resource_id
        and owner.disabled_at is null
    )
  then
    raise check_violation using
      constraint = 'permissions_mailbox_scope_check',
      message = 'mailbox delegation requires an active owner grant to another actor';
  end if;
  return new;
end
$$;

drop trigger if exists permissions_validate_mailbox on permissions;
create trigger permissions_validate_mailbox
before insert or update of org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
on permissions
for each row execute function helix_validate_mailbox_permission();

create unique index if not exists permissions_active_mailbox_delegate_idx
  on permissions (org_id, resource_id, actor_id)
  where resource_type = 'mailbox' and status = 'active';

-- Shared primitives remain tenant-only for non-mail data and become mailbox
-- scoped only for mail rows.
drop policy if exists helix_tenant_isolation on threads;
create policy helix_tenant_isolation on threads
  using (
    org_id = helix_current_org_id()
    and (
      kind <> 'mail'
      or helix_can_read_mail_thread(org_id, id)
      or created_by_actor_id = helix_current_actor_id()
    )
  )
  with check (
    org_id = helix_current_org_id()
    and (
      kind <> 'mail'
      or helix_mail_service_context(org_id)
      or created_by_actor_id = helix_current_actor_id()
      or helix_can_read_mail_thread(org_id, id)
    )
  );

drop policy if exists helix_tenant_isolation on messages;
create policy helix_tenant_isolation on messages
  using (
    org_id = helix_current_org_id()
    and (kind <> 'mail' or helix_can_read_mail_message(org_id, id))
  )
  with check (
    org_id = helix_current_org_id()
    and (kind <> 'mail' or helix_can_write_mail_thread(org_id, thread_id))
  );

alter table message_attachments enable row level security;
alter table message_attachments force row level security;
drop policy if exists helix_tenant_isolation on message_attachments;
create policy helix_tenant_isolation on message_attachments
  using (
    org_id = helix_current_org_id()
    and helix_can_read_message_attachment(org_id, message_id)
  )
  with check (
    org_id = helix_current_org_id()
    and helix_can_write_message_attachment(org_id, message_id)
  );

drop policy if exists helix_tenant_isolation on objects;
create policy helix_tenant_isolation on objects
  using (
    org_id = helix_current_org_id()
    and helix_can_read_mail_object(org_id, id, kind::text, owner_actor_id)
  )
  with check (
    org_id = helix_current_org_id()
    and helix_can_write_mail_object(org_id, id, kind::text, owner_actor_id)
  );

drop policy if exists helix_tenant_isolation on mail_message_identities;
create policy helix_tenant_isolation on mail_message_identities
  using (
    org_id = helix_current_org_id()
    and helix_can_read_mail_message(org_id, message_id)
  )
  with check (
    org_id = helix_current_org_id()
    and helix_can_write_mail_message(org_id, message_id)
  );

drop policy if exists helix_tenant_isolation on mail_raw_sources;
create policy helix_tenant_isolation on mail_raw_sources
  using (
    org_id = helix_current_org_id()
    and helix_can_read_mail_message(org_id, message_id)
  )
  with check (
    org_id = helix_current_org_id()
    and helix_mail_service_context(org_id)
  );

drop policy if exists helix_tenant_isolation on mail_message_deliveries;
create policy helix_tenant_isolation on mail_message_deliveries
  using (
    org_id = helix_current_org_id()
    and helix_can_access_mailbox(org_id, actor_id)
  )
  with check (
    org_id = helix_current_org_id()
    and helix_mail_service_context(org_id)
  );

drop policy if exists helix_tenant_isolation on mail_thread_state;
create policy helix_tenant_isolation on mail_thread_state
  using (
    org_id = helix_current_org_id()
    and helix_can_access_mailbox(org_id, actor_id)
  )
  with check (
    org_id = helix_current_org_id()
    and (
      helix_mail_service_context(org_id)
      or (
        helix_can_access_mailbox(org_id, actor_id)
        and helix_mailbox_owns_thread(org_id, actor_id, thread_id)
      )
    )
  );

do $$
declare
  mailbox_table text;
begin
  foreach mailbox_table in array array[
    'mail_filters',
    'mail_aliases',
    'mail_vacation',
    'mail_vacation_responses',
    'mail_outbound_messages',
    'mail_drafts'
  ]
  loop
    execute format('drop policy if exists helix_tenant_isolation on %I', mailbox_table);
    execute format(
      'create policy helix_tenant_isolation on %I using (org_id = helix_current_org_id() and helix_can_access_mailbox(org_id, actor_id)) with check (org_id = helix_current_org_id() and helix_can_access_mailbox(org_id, actor_id))',
      mailbox_table
    );
  end loop;
end
$$;

drop policy if exists helix_tenant_isolation on mail_labels;
create policy helix_tenant_isolation on mail_labels
  using (
    org_id = helix_current_org_id()
    and (owner_actor_id is null or helix_can_access_mailbox(org_id, owner_actor_id))
  )
  with check (
    org_id = helix_current_org_id()
    and (owner_actor_id is null or helix_can_access_mailbox(org_id, owner_actor_id))
  );

drop policy if exists helix_tenant_isolation on permissions;
create policy helix_tenant_isolation on permissions
  using (
    org_id = helix_current_org_id()
    and (
      resource_type <> 'mailbox'
      or helix_mail_service_context(org_id)
      or actor_id = helix_current_actor_id()
      or resource_id = helix_current_actor_id()
    )
  )
  with check (
    org_id = helix_current_org_id()
    and (
      resource_type <> 'mailbox'
      or helix_mail_service_context(org_id)
      or (
        resource_id = helix_current_actor_id()
        and granted_by_actor_id = helix_current_actor_id()
        and role = 'manager'
      )
    )
  );

create or replace function helix_protect_mail_message_content()
returns trigger
language plpgsql
as $$
begin
  if old.kind = 'mail' and (
    new.org_id is distinct from old.org_id
    or new.thread_id is distinct from old.thread_id
    or new.actor_id is distinct from old.actor_id
    or new.kind is distinct from old.kind
    or new.body is distinct from old.body
    or new.body_format is distinct from old.body_format
    or new.sent_at is distinct from old.sent_at
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'canonical mail content is immutable';
  end if;
  return new;
end
$$;

drop trigger if exists messages_protect_mail_content on messages;
create trigger messages_protect_mail_content
before update on messages
for each row execute function helix_protect_mail_message_content();

do $$
declare
  routine regprocedure;
begin
  foreach routine in array array[
    'helix_mail_service_context(uuid)'::regprocedure,
    'helix_can_access_mailbox(uuid,uuid)'::regprocedure,
    'helix_mailbox_owns_thread(uuid,uuid,uuid)'::regprocedure,
    'helix_can_read_mail_thread(uuid,uuid)'::regprocedure,
    'helix_can_write_mail_thread(uuid,uuid)'::regprocedure,
    'helix_can_read_mail_message(uuid,uuid)'::regprocedure,
    'helix_can_write_mail_message(uuid,uuid)'::regprocedure,
    'helix_can_read_message_attachment(uuid,uuid)'::regprocedure,
    'helix_can_write_message_attachment(uuid,uuid)'::regprocedure,
    'helix_can_read_mail_object(uuid,uuid,text,uuid)'::regprocedure,
    'helix_can_write_mail_object(uuid,uuid,text,uuid)'::regprocedure
  ]
  loop
    execute format('alter function %s owner to helix_migration_owner', routine);
    execute format('revoke all on function %s from public', routine);
    execute format(
      'grant execute on function %s to helix_app, helix_worker, helix_readonly',
      routine
    );
  end loop;
end
$$;

alter function helix_protect_mail_message_content() owner to helix_migration_owner;
revoke all on function helix_protect_mail_message_content() from public;
alter function helix_validate_mailbox_permission() owner to helix_migration_owner;
revoke all on function helix_validate_mailbox_permission() from public;
