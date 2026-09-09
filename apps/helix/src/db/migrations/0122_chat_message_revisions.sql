alter table messages add column if not exists chat_revision bigint not null default 1;

alter table messages drop constraint if exists messages_chat_revision_positive;
alter table messages
  add constraint messages_chat_revision_positive check (chat_revision > 0);

create table if not exists chat_message_revisions (
  org_id uuid not null,
  message_id uuid not null,
  revision bigint not null check (revision > 0),
  body text not null,
  body_format text not null,
  metadata jsonb not null,
  edited_at timestamptz,
  deleted_at timestamptz,
  changed_by_actor_id uuid,
  captured_at timestamptz not null default now(),
  primary key (message_id, revision),
  constraint chat_message_revisions_message_org_fk
    foreign key (org_id, message_id) references messages (org_id, id) on delete cascade,
  constraint chat_message_revisions_actor_org_fk
    foreign key (org_id, changed_by_actor_id) references actors (org_id, id)
);

create index if not exists chat_message_revisions_org_time_idx
  on chat_message_revisions (org_id, captured_at desc, message_id);

alter table chat_message_revisions enable row level security;
alter table chat_message_revisions force row level security;
drop policy if exists helix_tenant_isolation on chat_message_revisions;
create policy helix_tenant_isolation on chat_message_revisions
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

create or replace function capture_chat_message_revision()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if old.kind = 'chat' and (
    old.body is distinct from new.body
    or old.body_format is distinct from new.body_format
    or old.deleted_at is distinct from new.deleted_at
  ) then
    insert into public.chat_message_revisions (
      org_id,
      message_id,
      revision,
      body,
      body_format,
      metadata,
      edited_at,
      deleted_at,
      changed_by_actor_id
    ) values (
      old.org_id,
      old.id,
      old.chat_revision,
      old.body,
      old.body_format,
      old.metadata,
      old.edited_at,
      old.deleted_at,
      public.helix_current_actor_id()
    );
    new.chat_revision := old.chat_revision + 1;
  end if;
  return new;
end
$$;

drop trigger if exists messages_capture_chat_revision on messages;
create trigger messages_capture_chat_revision
before update of body, body_format, deleted_at on messages
for each row execute function capture_chat_message_revision();

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'helix_runtime') then
    revoke update, delete, truncate on chat_message_revisions from helix_runtime;
  end if;
end
$$;
