-- The unified ACL evaluator reads the resource row. Capture the old audience
-- before a move/deletion and evaluate new visibility after the row is stored.
-- Both entries remain in the same transaction as the resource mutation.
create or replace function helix_drive_webdav_folder_change()
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
    if tg_when = 'BEFORE' then
      old_audience := helix_drive_webdav_audience(old.org_id, 'drive_folder', old.id, old.owner_actor_id, old.parent_folder_id);
    end if;
  end if;
  if tg_op <> 'DELETE' then
    new_parent := coalesce(helix_drive_webdav_folder_path(new.org_id, new.parent_folder_id), '');
    new_path := new_parent || '/' || new.name;
    if tg_when = 'AFTER' then
      new_audience := helix_drive_webdav_audience(new.org_id, 'drive_folder', new.id, new.owner_actor_id, new.parent_folder_id);
    end if;
  end if;
  if tg_when = 'BEFORE' and (tg_op = 'DELETE' or
     (tg_op = 'UPDATE' and old.deleted_at is null and (new.deleted_at is not null or old_path <> new_path))) then
    perform helix_drive_webdav_emit(old.org_id, coalesce(nullif(old_parent, ''), '/'), old_path, old.id, 'folder'::text, 404::smallint, old_audience);
  end if;
  if tg_when = 'AFTER' and ((tg_op = 'INSERT' and new.deleted_at is null) or
     (tg_op = 'UPDATE' and new.deleted_at is null and (old.deleted_at is not null or old_path <> new_path))) then
    perform helix_drive_webdav_emit(new.org_id, coalesce(nullif(new_parent, ''), '/'), new_path, new.id, 'folder'::text, 200::smallint, new_audience);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create or replace function helix_drive_webdav_object_change()
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
    if tg_when = 'BEFORE' then
      old_audience := helix_drive_webdav_audience(old.org_id, 'object', old.id, old.owner_actor_id, nullif(old.metadata->>'folderId', '')::uuid);
    end if;
  end if;
  if tg_op <> 'DELETE' and new.kind = 'file' then
    new_parent := coalesce(helix_drive_webdav_folder_path(new.org_id, nullif(new.metadata->>'folderId', '')::uuid), '');
    new_path := new_parent || '/' || coalesce(new.metadata->>'name', new.id::text);
    new_ready := coalesce(new.metadata->>'status', 'ready') = 'ready' and new.deleted_at is null;
    if tg_when = 'AFTER' then
      new_audience := helix_drive_webdav_audience(new.org_id, 'object', new.id, new.owner_actor_id, nullif(new.metadata->>'folderId', '')::uuid);
    end if;
  end if;
  if tg_when = 'BEFORE' and tg_op <> 'INSERT' and old.kind = 'file' and old_ready and
     (tg_op = 'DELETE' or new.kind <> 'file' or new.deleted_at is not null or old_path <> new_path) then
    perform helix_drive_webdav_emit(old.org_id, coalesce(nullif(old_parent, ''), '/'), old_path, old.id, 'file'::text, 404::smallint, old_audience);
  end if;
  if tg_when = 'AFTER' and tg_op <> 'DELETE' and new.kind = 'file' and new_ready and
     (tg_op = 'INSERT' or old.kind <> 'file' or not old_ready or old_path <> new_path or
      old.storage_key is distinct from new.storage_key or old.sha256 is distinct from new.sha256) then
    perform helix_drive_webdav_emit(new.org_id, coalesce(nullif(new_parent, ''), '/'), new_path, new.id, 'file'::text, 200::smallint, new_audience);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

drop trigger drive_webdav_folder_change on drive_folders;
create trigger drive_webdav_folder_change
before update or delete on drive_folders
for each row execute function helix_drive_webdav_folder_change();
create trigger drive_webdav_folder_change_after
  after insert or update on drive_folders
  for each row execute function helix_drive_webdav_folder_change();

drop trigger drive_webdav_object_change on objects;
create trigger drive_webdav_object_change
before update or delete on objects
for each row execute function helix_drive_webdav_object_change();
create trigger drive_webdav_object_change_after
  after insert or update on objects
  for each row execute function helix_drive_webdav_object_change();
