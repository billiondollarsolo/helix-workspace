-- Chat retention, legal holds, tombstones, and reconnect deduplication.

alter table messages
  add column if not exists tombstoned_at timestamptz,
  add column if not exists tombstone_reason text;

alter table messages
  drop constraint if exists messages_chat_tombstone_reason_check,
  add constraint messages_chat_tombstone_reason_check
    check (
      tombstone_reason is null
      or tombstone_reason in ('user_delete', 'retention')
    );

create table if not exists chat_retention_policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  thread_id uuid,
  retention_days integer not null default 2555 check (retention_days between 1 and 36500),
  edit_window_seconds integer not null default 86400
    check (edit_window_seconds between 0 and 31536000),
  delete_window_seconds integer not null default 86400
    check (delete_window_seconds between 0 and 31536000),
  legal_hold boolean not null default false,
  changed_by_actor_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists chat_retention_org_default_unique
  on chat_retention_policies (org_id)
  where thread_id is null;
create unique index if not exists chat_retention_room_override_unique
  on chat_retention_policies (org_id, thread_id)
  where thread_id is not null;

alter table chat_retention_policies
  add constraint chat_retention_policy_thread_org_fk
    foreign key (org_id, thread_id)
    references threads (org_id, id)
    on delete cascade
    not valid,
  add constraint chat_retention_policy_actor_org_fk
    foreign key (org_id, changed_by_actor_id)
    references actors (org_id, id)
    not valid;

-- Preserve the first accepted message for a retry key. Later historical
-- duplicates remain messages, but lose the retry key before uniqueness.
with ranked as (
  select
    id,
    row_number() over (
      partition by org_id, thread_id, actor_id, metadata->>'clientMessageId'
      order by created_at, id
    ) as position
  from messages
  where kind = 'chat'
    and actor_id is not null
    and metadata ? 'clientMessageId'
)
update messages
set metadata = metadata - 'clientMessageId'
where id in (select id from ranked where position > 1);

create unique index if not exists chat_message_client_retry_unique
  on messages (org_id, thread_id, actor_id, (metadata->>'clientMessageId'))
  where kind = 'chat'
    and actor_id is not null
    and metadata ? 'clientMessageId';

create or replace function helix_enforce_chat_tombstone()
returns trigger
language plpgsql
as $$
begin
  if new.kind = 'chat' and new.deleted_at is not null then
    new.body := '';
    new.body_format := 'plain';
    new.metadata := jsonb_build_object('tombstone', true);
    new.tombstoned_at := coalesce(new.tombstoned_at, new.deleted_at, now());
    new.tombstone_reason := coalesce(new.tombstone_reason, 'user_delete');
  end if;
  return new;
end
$$;

drop trigger if exists messages_enforce_chat_tombstone on messages;
create trigger messages_enforce_chat_tombstone
before insert or update on messages
for each row execute function helix_enforce_chat_tombstone();

-- Existing soft-deleted Chat content is removed during the migration.
update messages
set
  body = '',
  body_format = 'plain',
  metadata = jsonb_build_object('tombstone', true),
  tombstoned_at = coalesce(deleted_at, now()),
  tombstone_reason = 'user_delete'
where kind = 'chat'
  and deleted_at is not null;

delete from message_attachments
where message_id in (
  select id from messages
  where kind = 'chat' and deleted_at is not null
);
