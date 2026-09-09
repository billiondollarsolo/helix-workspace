create table drive_webdav_collections (
  org_id uuid not null references orgs(id) on delete cascade,
  path_key text not null check (path_key like '/%' and length(path_key) <= 4096),
  version bigint not null default 0 check (version >= 0),
  min_version bigint not null default 0 check (min_version >= 0 and min_version <= version),
  primary key (org_id, path_key)
);

create table drive_webdav_changes (
  org_id uuid not null,
  collection_path_key text not null,
  version bigint not null,
  resource_path_key text not null check (
    resource_path_key like '/%' and length(resource_path_key) <= 4096
  ),
  resource_id uuid not null,
  resource_type text not null check (resource_type in ('file', 'folder')),
  status smallint not null check (status in (200, 404)),
  audience_actor_ids uuid[] not null,
  created_at timestamptz not null default statement_timestamp(),
  primary key (org_id, collection_path_key, version),
  foreign key (org_id, collection_path_key)
    references drive_webdav_collections(org_id, path_key) on delete cascade
);

create index drive_webdav_changes_audience_idx
  on drive_webdav_changes using gin (audience_actor_ids);

alter table drive_webdav_collections enable row level security;
alter table drive_webdav_collections force row level security;
alter table drive_webdav_changes enable row level security;
alter table drive_webdav_changes force row level security;

create policy drive_webdav_collections_tenant_read on drive_webdav_collections for select
  using (org_id = helix_current_org_id());
create policy drive_webdav_changes_tenant_read on drive_webdav_changes for select
  using (org_id = helix_current_org_id());

create function helix_drive_webdav_folder_path(p_org_id uuid, p_folder_id uuid)
returns text
language sql
stable
set search_path = pg_catalog, public
set row_security = off
as $$
  with recursive chain as (
    select id, name, parent_folder_id, 1 as depth
    from drive_folders where org_id = p_org_id and id = p_folder_id
    union all
    select parent.id, parent.name, parent.parent_folder_id, child.depth + 1
    from drive_folders parent join chain child on child.parent_folder_id = parent.id
    where parent.org_id = p_org_id
  )
  select coalesce('/' || string_agg(name, '/' order by depth desc), '') from chain
$$;

create function helix_drive_webdav_audience(
  p_org_id uuid, p_resource_type text, p_resource_id uuid, p_owner_actor_id uuid,
  p_folder_id uuid
)
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  with recursive folders as (
    select folder.id, folder.parent_folder_id, folder.owner_actor_id
    from drive_folders folder
    where folder.org_id = p_org_id and (
      (p_resource_type = 'drive_folder' and folder.id in (p_resource_id, p_folder_id))
      or (p_resource_type = 'object' and folder.id = p_folder_id)
    )
    union
    select parent.id, parent.parent_folder_id, parent.owner_actor_id
    from drive_folders parent join folders child on child.parent_folder_id = parent.id
    where parent.org_id = p_org_id
  ), audience as (
    select p_owner_actor_id as actor_id
    union all
    select actor_id from permissions
    where org_id = p_org_id and resource_type = p_resource_type and resource_id = p_resource_id
      and coalesce(status, 'active') = 'active' and revoked_at is null
      and valid_from <= statement_timestamp()
      and (expires_at is null or expires_at > statement_timestamp())
    union all
    select owner_actor_id from folders
    union all
    select permission.actor_id
    from folders join permissions permission
      on permission.org_id = p_org_id
      and permission.resource_type = 'drive_folder'
      and permission.resource_id = folders.id
      and permission.status = 'active' and permission.revoked_at is null
      and permission.valid_from <= statement_timestamp()
      and (permission.expires_at is null or permission.expires_at > statement_timestamp())
  )
  select coalesce(array_agg(distinct actor_id), array[]::uuid[]) from audience
  where actor_id is not null
$$;

create function helix_drive_webdav_emit(
  p_org_id uuid, p_collection_path text, p_resource_path text, p_resource_id uuid,
  p_resource_type text, p_status smallint, p_audience uuid[]
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare next_version bigint;
begin
  -- One tiny tenant lock prevents opposite-direction moves from deadlocking
  -- while they atomically append to both source and destination collections.
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 157));
  insert into drive_webdav_collections(org_id, path_key, version)
  values (p_org_id, p_collection_path, 1)
  on conflict (org_id, path_key) do update
    set version = drive_webdav_collections.version + 1
  returning version into next_version;

  insert into drive_webdav_changes(
    org_id, collection_path_key, version, resource_path_key, resource_id,
    resource_type, status, audience_actor_ids
  ) values (
    p_org_id, p_collection_path, next_version, p_resource_path, p_resource_id,
    p_resource_type, p_status, p_audience
  );

  if next_version > 10000 then
    delete from drive_webdav_changes
    where org_id = p_org_id and collection_path_key = p_collection_path
      and version <= next_version - 10000;
    update drive_webdav_collections set min_version = next_version - 10000
    where org_id = p_org_id and path_key = p_collection_path;
  end if;
end
$$;

create function helix_drive_webdav_folder_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare old_parent text; new_parent text; old_path text; new_path text; old_audience uuid[]; new_audience uuid[];
begin
  if tg_op <> 'INSERT' then
    old_parent := coalesce(helix_drive_webdav_folder_path(old.org_id, old.parent_folder_id), '');
    old_path := old_parent || '/' || old.name;
    old_audience := helix_drive_webdav_audience(old.org_id, 'drive_folder', old.id, old.owner_actor_id, old.parent_folder_id);
  end if;
  if tg_op <> 'DELETE' then
    new_parent := coalesce(helix_drive_webdav_folder_path(new.org_id, new.parent_folder_id), '');
    new_path := new_parent || '/' || new.name;
    new_audience := helix_drive_webdav_audience(new.org_id, 'drive_folder', new.id, new.owner_actor_id, new.parent_folder_id);
  end if;
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.deleted_at is null and (new.deleted_at is not null or old_path <> new_path)) then
    perform helix_drive_webdav_emit(old.org_id, coalesce(nullif(old_parent, ''), '/'), old_path, old.id, 'folder'::text, 404::smallint, old_audience);
  end if;
  if (tg_op = 'INSERT' and new.deleted_at is null) or
     (tg_op = 'UPDATE' and new.deleted_at is null and (old.deleted_at is not null or old_path <> new_path)) then
    perform helix_drive_webdav_emit(new.org_id, coalesce(nullif(new_parent, ''), '/'), new_path, new.id, 'folder'::text, 200::smallint, new_audience);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create function helix_drive_webdav_object_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare old_parent text; new_parent text; old_path text; new_path text; old_ready boolean; new_ready boolean;
declare old_audience uuid[]; new_audience uuid[];
begin
  if tg_op <> 'INSERT' and old.kind = 'file' then
    old_parent := coalesce(helix_drive_webdav_folder_path(old.org_id, nullif(old.metadata->>'folderId', '')::uuid), '');
    old_path := old_parent || '/' || coalesce(old.metadata->>'name', old.id::text);
    old_ready := coalesce(old.metadata->>'status', 'ready') = 'ready' and old.deleted_at is null;
    old_audience := helix_drive_webdav_audience(old.org_id, 'object', old.id, old.owner_actor_id, nullif(old.metadata->>'folderId', '')::uuid);
  end if;
  if tg_op <> 'DELETE' and new.kind = 'file' then
    new_parent := coalesce(helix_drive_webdav_folder_path(new.org_id, nullif(new.metadata->>'folderId', '')::uuid), '');
    new_path := new_parent || '/' || coalesce(new.metadata->>'name', new.id::text);
    new_ready := coalesce(new.metadata->>'status', 'ready') = 'ready' and new.deleted_at is null;
    new_audience := helix_drive_webdav_audience(new.org_id, 'object', new.id, new.owner_actor_id, nullif(new.metadata->>'folderId', '')::uuid);
  end if;
  if tg_op <> 'INSERT' and old.kind = 'file' and old_ready and
     (tg_op = 'DELETE' or new.kind <> 'file' or new.deleted_at is not null or old_path <> new_path) then
    perform helix_drive_webdav_emit(old.org_id, coalesce(nullif(old_parent, ''), '/'), old_path, old.id, 'file'::text, 404::smallint, old_audience);
  end if;
  if tg_op <> 'DELETE' and new.kind = 'file' and new_ready and
     (tg_op = 'INSERT' or old.kind <> 'file' or not old_ready or old_path <> new_path or
      old.storage_key is distinct from new.storage_key or old.sha256 is distinct from new.sha256) then
    perform helix_drive_webdav_emit(new.org_id, coalesce(nullif(new_parent, ''), '/'), new_path, new.id, 'file'::text, 200::smallint, new_audience);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create trigger drive_webdav_folder_change
before insert or update or delete on drive_folders
for each row execute function helix_drive_webdav_folder_change();
create trigger drive_webdav_object_change
before insert or update or delete on objects
for each row execute function helix_drive_webdav_object_change();

alter table drive_webdav_collections owner to helix_migration_owner;
alter table drive_webdav_changes owner to helix_migration_owner;
alter function helix_drive_webdav_folder_path(uuid, uuid) owner to helix_migration_owner;
alter function helix_drive_webdav_audience(uuid, text, uuid, uuid, uuid) owner to helix_migration_owner;
alter function helix_drive_webdav_emit(uuid, text, text, uuid, text, smallint, uuid[]) owner to helix_migration_owner;
alter function helix_drive_webdav_folder_change() owner to helix_migration_owner;
alter function helix_drive_webdav_object_change() owner to helix_migration_owner;
revoke all on drive_webdav_collections, drive_webdav_changes from public;
revoke all on function helix_drive_webdav_folder_path(uuid, uuid) from public;
revoke all on function helix_drive_webdav_audience(uuid, text, uuid, uuid, uuid) from public;
revoke all on function helix_drive_webdav_emit(uuid, text, text, uuid, text, smallint, uuid[]) from public;
revoke all on function helix_drive_webdav_folder_change() from public;
revoke all on function helix_drive_webdav_object_change() from public;
grant select on drive_webdav_collections, drive_webdav_changes to helix_app;
