-- Drive comments are a mutable projection over immutable evidence. Access is
-- derived from the object owner plus current direct and inherited folder
-- grants; comment deletion is a tombstone, never a row delete.

alter table drive_comments
  add column if not exists revision bigint not null default 1,
  add column if not exists changed_by_actor_id uuid,
  add column if not exists resolved_by_actor_id uuid,
  add column if not exists deleted_by_actor_id uuid,
  add column if not exists deleted_at timestamptz;

alter table drive_comments drop constraint if exists drive_comments_revision_positive;
alter table drive_comments
  add constraint drive_comments_revision_positive check (revision > 0);

create unique index if not exists drive_comments_org_object_id_unique_idx
  on drive_comments (org_id, object_id, id);

-- A reply can only point at a comment in the same tenant and object.
do $$
declare
  parent_fk record;
  parent_column smallint;
begin
  select attnum into parent_column
  from pg_attribute
  where attrelid = 'drive_comments'::regclass and attname = 'parent_comment_id';

  for parent_fk in
    select conname
    from pg_constraint
    where conrelid = 'drive_comments'::regclass
      and confrelid = 'drive_comments'::regclass
      and contype = 'f'
      and parent_column = any(conkey)
  loop
    execute format('alter table drive_comments drop constraint %I', parent_fk.conname);
  end loop;
end
$$;

alter table drive_comments
  add constraint drive_comments_parent_same_object_fk
  foreign key (org_id, object_id, parent_comment_id)
  references drive_comments (org_id, object_id, id) on delete cascade;

create table drive_comment_revisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  object_id uuid not null,
  comment_id uuid not null,
  revision bigint not null check (revision > 0),
  change_kind text not null
    check (change_kind in ('created', 'edited', 'resolved', 'reopened', 'deleted')),
  parent_comment_id uuid,
  comment_actor_id uuid,
  anchor jsonb not null,
  body text not null,
  status text not null check (status in ('open', 'resolved')),
  metadata jsonb not null,
  resolved_at timestamptz,
  resolved_by_actor_id uuid,
  deleted_at timestamptz,
  deleted_by_actor_id uuid,
  changed_by_actor_id uuid not null,
  captured_at timestamptz not null default now(),
  constraint drive_comment_revisions_comment_revision_unique
    unique (org_id, comment_id, revision),
  constraint drive_comment_revisions_comment_fk
    foreign key (org_id, object_id, comment_id)
    references drive_comments (org_id, object_id, id) on delete cascade
);

create index drive_comment_revisions_object_cursor_idx
  on drive_comment_revisions (org_id, object_id, captured_at, id);

-- Preserve the pre-migration projection as revision one. RLS is temporarily
-- disabled inside this transactional migration so upgrades do not silently
-- omit tenants when the migration role has no request GUC.
alter table drive_comments disable row level security;
insert into drive_comment_revisions (
  org_id, object_id, comment_id, revision, change_kind, parent_comment_id,
  comment_actor_id, anchor, body, status, metadata, resolved_at,
  resolved_by_actor_id, deleted_at, deleted_by_actor_id, changed_by_actor_id,
  captured_at
)
select
  org_id, object_id, id, revision, 'created', parent_comment_id,
  actor_id, anchor, body, status, metadata, resolved_at,
  resolved_by_actor_id, deleted_at, deleted_by_actor_id,
  coalesce(changed_by_actor_id, actor_id), created_at
from drive_comments
where coalesce(changed_by_actor_id, actor_id) is not null
on conflict (org_id, comment_id, revision) do nothing;
alter table drive_comments enable row level security;
alter table drive_comments force row level security;

create or replace function drive_comment_actor_role_rank(
  input_org_id uuid,
  input_object_id uuid,
  input_actor_id uuid
)
returns integer
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with recursive target as (
    select object.id, object.owner_actor_id, object.metadata
    from public.objects object
    where object.org_id = input_org_id
      and object.id = input_object_id
      and object.kind in ('file', 'recording')
      and object.deleted_at is null
      and coalesce(object.metadata->>'status', 'ready') = 'ready'
  ), folders as (
    select folder.id, folder.parent_folder_id, folder.owner_actor_id
    from public.drive_folders folder
    join target on folder.org_id = input_org_id
      and folder.id::text = target.metadata->>'folderId'
      and folder.deleted_at is null
    union
    select parent.id, parent.parent_folder_id, parent.owner_actor_id
    from public.drive_folders parent
    join folders child on child.parent_folder_id = parent.id
    where parent.org_id = input_org_id and parent.deleted_at is null
  ), ranks as (
    select 3 as rank
    from target
    where owner_actor_id = input_actor_id
    union all
    select case permission.role
      when 'owner' then 3 when 'editor' then 2 when 'commenter' then 1
      when 'reader' then 0 else -1 end
    from target
    join public.permissions permission
      on permission.org_id = input_org_id
      and permission.resource_type = 'object'
      and permission.resource_id = target.id
      and permission.actor_id = input_actor_id
      and permission.status = 'active'
      and permission.revoked_at is null
      and permission.valid_from <= now()
      and (permission.expires_at is null or permission.expires_at > now())
    union all
    select 2 from folders where owner_actor_id = input_actor_id
    union all
    select case permission.role
      when 'owner' then 3 when 'editor' then 2 when 'commenter' then 1
      when 'reader' then 0 else -1 end
    from folders
    join public.permissions permission
      on permission.org_id = input_org_id
      and permission.resource_type = 'drive_folder'
      and permission.resource_id = folders.id
      and permission.actor_id = input_actor_id
      and permission.status = 'active'
      and permission.revoked_at is null
      and permission.valid_from <= now()
      and (permission.expires_at is null or permission.expires_at > now())
  )
  select coalesce(max(rank), -1)::integer from ranks
$$;

create or replace function drive_comment_thread_owner_id(
  input_org_id uuid,
  input_comment_id uuid
)
returns uuid
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with recursive ancestors as (
    select comment.id, comment.parent_comment_id, comment.actor_id, array[comment.id] as path
    from public.drive_comments comment
    where comment.org_id = input_org_id and comment.id = input_comment_id
    union all
    select parent.id, parent.parent_comment_id, parent.actor_id, ancestors.path || parent.id
    from public.drive_comments parent
    join ancestors on ancestors.parent_comment_id = parent.id
    where parent.org_id = input_org_id
      and not parent.id = any(ancestors.path)
  )
  select actor_id from ancestors where parent_comment_id is null limit 1
$$;

create or replace function authorize_drive_comment_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  acting_actor_id uuid;
  role_rank integer;
  thread_owner_id uuid;
  meaningful_change boolean;
begin
  acting_actor_id := coalesce(
    public.helix_current_actor_id(),
    new.changed_by_actor_id,
    case when tg_op = 'INSERT' then new.actor_id else null end
  );
  if acting_actor_id is null then
    raise insufficient_privilege using message = 'Drive comment mutation requires an actor';
  end if;

  role_rank := public.drive_comment_actor_role_rank(
    new.org_id, new.object_id, acting_actor_id
  );

  if tg_op = 'INSERT' then
    if new.actor_id is distinct from acting_actor_id or role_rank < 1 then
      raise insufficient_privilege using
        message = 'Creating a Drive comment requires commenter access';
    end if;
    if new.status <> 'open'
       or new.resolved_at is not null
       or new.resolved_by_actor_id is not null then
      raise check_violation using message = 'A new Drive comment must start open';
    end if;
    if new.deleted_at is not null or new.deleted_by_actor_id is not null then
      raise check_violation using message = 'A new Drive comment cannot be deleted';
    end if;
    new.revision := 1;
    new.changed_by_actor_id := acting_actor_id;
    return new;
  end if;

  if role_rank < 0 then
    raise insufficient_privilege using message = 'Drive comment access was revoked';
  end if;
  if old.deleted_at is not null then
    raise check_violation using message = 'A deleted Drive comment is immutable';
  end if;
  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.object_id is distinct from old.object_id
     or new.parent_comment_id is distinct from old.parent_comment_id
     or new.actor_id is distinct from old.actor_id
     or new.metadata is distinct from old.metadata
     or new.created_at is distinct from old.created_at then
    raise check_violation using message = 'Drive comment identity and anchors are immutable';
  end if;

  if new.anchor is distinct from old.anchor and role_rank < 2 then
    raise insufficient_privilege using
      message = 'Only an editor can re-anchor a Drive comment';
  end if;

  if new.body is distinct from old.body
     and acting_actor_id is distinct from old.actor_id
     and role_rank < 2 then
    raise insufficient_privilege using
      message = 'Only the comment author or an editor can edit it';
  end if;

  if new.status is distinct from old.status then
    thread_owner_id := public.drive_comment_thread_owner_id(old.org_id, old.id);
    if role_rank < 2 and acting_actor_id is distinct from thread_owner_id then
      raise insufficient_privilege using
        message = 'Only an editor or thread owner can resolve a comment thread';
    end if;
    if new.status = 'resolved' then
      if new.resolved_at is null or new.resolved_by_actor_id is distinct from acting_actor_id then
        raise check_violation using message = 'Resolution actor and time are required';
      end if;
    elsif new.status = 'open' then
      if new.resolved_at is not null or new.resolved_by_actor_id is not null then
        raise check_violation using message = 'Reopened comments cannot retain resolution metadata';
      end if;
    else
      raise check_violation using message = 'Invalid Drive comment status';
    end if;
  elsif new.resolved_at is distinct from old.resolved_at
     or new.resolved_by_actor_id is distinct from old.resolved_by_actor_id then
    raise check_violation using message = 'Resolution metadata changes only with status';
  end if;

  if new.deleted_at is distinct from old.deleted_at then
    if acting_actor_id is distinct from old.actor_id and role_rank < 2 then
      raise insufficient_privilege using
        message = 'Only the comment author or an editor can delete it';
    end if;
    if new.deleted_at is null or new.deleted_by_actor_id is distinct from acting_actor_id then
      raise check_violation using message = 'Deletion actor and time are required';
    end if;
  elsif new.deleted_by_actor_id is distinct from old.deleted_by_actor_id then
    raise check_violation using message = 'Deletion metadata changes only on deletion';
  end if;

  meaningful_change := new.body is distinct from old.body
    or new.anchor is distinct from old.anchor
    or new.status is distinct from old.status
    or new.deleted_at is distinct from old.deleted_at;
  if not meaningful_change then
    raise check_violation using message = 'A Drive comment update must change its content or state';
  end if;
  new.updated_at := now();
  new.changed_by_actor_id := acting_actor_id;
  new.revision := old.revision + 1;
  return new;
end
$$;

create or replace function capture_drive_comment_revision()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  change_kind text;
begin
  change_kind := case
    when tg_op = 'INSERT' then 'created'
    when new.deleted_at is distinct from old.deleted_at then 'deleted'
    when new.status = 'resolved' and new.status is distinct from old.status then 'resolved'
    when new.status = 'open' and new.status is distinct from old.status then 'reopened'
    else 'edited'
  end;
  insert into public.drive_comment_revisions (
    org_id, object_id, comment_id, revision, change_kind, parent_comment_id,
    comment_actor_id, anchor, body, status, metadata, resolved_at,
    resolved_by_actor_id, deleted_at, deleted_by_actor_id, changed_by_actor_id
  ) values (
    new.org_id, new.object_id, new.id, new.revision, change_kind, new.parent_comment_id,
    new.actor_id, new.anchor, new.body, new.status, new.metadata, new.resolved_at,
    new.resolved_by_actor_id, new.deleted_at, new.deleted_by_actor_id,
    new.changed_by_actor_id
  );
  return new;
end
$$;

drop trigger if exists drive_comments_authorize_mutation on drive_comments;
create trigger drive_comments_authorize_mutation
before insert or update on drive_comments
for each row execute function authorize_drive_comment_mutation();

drop trigger if exists drive_comments_capture_revision on drive_comments;
drop trigger if exists drive_comments_capture_insert on drive_comments;
drop trigger if exists drive_comments_capture_update on drive_comments;
create trigger drive_comments_capture_insert
after insert on drive_comments
for each row execute function capture_drive_comment_revision();
create trigger drive_comments_capture_update
after update on drive_comments
for each row when (old.revision is distinct from new.revision)
execute function capture_drive_comment_revision();

alter table drive_comment_revisions enable row level security;
alter table drive_comment_revisions force row level security;

drop policy if exists helix_tenant_isolation on drive_comments;
drop policy if exists drive_comments_read on drive_comments;
drop policy if exists drive_comments_create on drive_comments;
drop policy if exists drive_comments_update on drive_comments;
create policy drive_comments_read on drive_comments for select
  using (
    org_id = helix_current_org_id()
    and drive_comment_actor_role_rank(org_id, object_id, helix_current_actor_id()) >= 0
  );
create policy drive_comments_create on drive_comments for insert
  with check (
    org_id = helix_current_org_id()
    and actor_id = helix_current_actor_id()
    and changed_by_actor_id = helix_current_actor_id()
    and drive_comment_actor_role_rank(org_id, object_id, helix_current_actor_id()) >= 1
  );
create policy drive_comments_update on drive_comments for update
  using (
    org_id = helix_current_org_id()
    and drive_comment_actor_role_rank(org_id, object_id, helix_current_actor_id()) >= 0
  )
  with check (
    org_id = helix_current_org_id()
    and changed_by_actor_id = helix_current_actor_id()
    and drive_comment_actor_role_rank(org_id, object_id, helix_current_actor_id()) >= 0
  );

create policy drive_comment_revisions_read on drive_comment_revisions for select
  using (
    org_id = helix_current_org_id()
    and drive_comment_actor_role_rank(org_id, object_id, helix_current_actor_id()) >= 2
  );
create policy drive_comment_revisions_append on drive_comment_revisions for insert
  with check (
    org_id = helix_current_org_id()
    and changed_by_actor_id = helix_current_actor_id()
  );

alter table drive_comment_revisions owner to helix_migration_owner;
alter function drive_comment_actor_role_rank(uuid, uuid, uuid) owner to helix_migration_owner;
alter function drive_comment_thread_owner_id(uuid, uuid) owner to helix_migration_owner;
alter function authorize_drive_comment_mutation() owner to helix_migration_owner;
alter function capture_drive_comment_revision() owner to helix_migration_owner;

revoke all on drive_comment_revisions from public;
revoke insert, update, delete, truncate on drive_comment_revisions
  from helix_app, helix_worker, helix_readonly;
grant select on drive_comment_revisions to helix_app, helix_worker;
grant select on drive_comment_revisions to helix_readonly;
revoke delete on drive_comments from helix_app;
grant execute on function drive_comment_actor_role_rank(uuid, uuid, uuid) to helix_app, helix_worker;
grant execute on function drive_comment_thread_owner_id(uuid, uuid) to helix_app, helix_worker;
