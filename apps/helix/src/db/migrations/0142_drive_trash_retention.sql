alter table objects
  add column trash_purge_after timestamptz,
  add column retain_until timestamptz;

alter table drive_folders
  add column trash_purge_after timestamptz,
  add column retain_until timestamptz;

update objects
set trash_purge_after = deleted_at + interval '30 days'
where deleted_at is not null and trash_purge_after is null;

update drive_folders
set trash_purge_after = deleted_at + interval '30 days'
where deleted_at is not null and trash_purge_after is null;

create function helix_set_drive_trash_deadline()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.deleted_at is null then
    new.trash_purge_after := null;
  elsif old.deleted_at is null or old.deleted_at is distinct from new.deleted_at then
    new.trash_purge_after := new.deleted_at + interval '30 days';
  end if;
  return new;
end
$$;

create trigger objects_set_trash_deadline
before update of deleted_at on objects
for each row execute function helix_set_drive_trash_deadline();

create trigger drive_folders_set_trash_deadline
before update of deleted_at on drive_folders
for each row execute function helix_set_drive_trash_deadline();

alter table objects
  add constraint objects_trash_deadline_shape check (
    (deleted_at is null and trash_purge_after is null)
    or (deleted_at is not null and trash_purge_after is not null and trash_purge_after >= deleted_at)
  ),
  add constraint objects_retention_shape check (retain_until is null or retain_until >= created_at);

alter table drive_folders
  add constraint drive_folders_trash_deadline_shape check (
    (deleted_at is null and trash_purge_after is null)
    or (deleted_at is not null and trash_purge_after is not null and trash_purge_after >= deleted_at)
  ),
  add constraint drive_folders_retention_shape check (retain_until is null or retain_until >= created_at);

create table drive_retention_holds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  resource_type text not null check (resource_type in ('object', 'folder')),
  resource_id uuid not null,
  reason text not null check (length(btrim(reason)) between 1 and 2000),
  created_by_actor_id uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  released_at timestamptz,
  released_by_actor_id uuid,
  foreign key (org_id, created_by_actor_id) references actors(org_id, id) on delete restrict,
  foreign key (org_id, released_by_actor_id) references actors(org_id, id) on delete restrict,
  check (expires_at is null or expires_at > created_at),
  check (
    (released_at is null and released_by_actor_id is null)
    or (released_at is not null and released_by_actor_id is not null and released_at >= created_at)
  )
);

create unique index drive_retention_holds_active_idx
  on drive_retention_holds (org_id, resource_type, resource_id)
  where released_at is null;

create index drive_retention_holds_expiry_idx
  on drive_retention_holds (org_id, expires_at)
  where released_at is null;

create function helix_validate_drive_retention_hold()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.resource_type = 'object' and not exists (
    select 1 from public.objects object
    where object.org_id = new.org_id and object.id = new.resource_id
  ) then raise foreign_key_violation using message = 'Drive hold object must belong to its tenant';
  elsif new.resource_type = 'folder' and not exists (
    select 1 from public.drive_folders folder
    where folder.org_id = new.org_id and folder.id = new.resource_id
  ) then raise foreign_key_violation using message = 'Drive hold folder must belong to its tenant';
  end if;
  return new;
end
$$;

create trigger drive_retention_holds_validate
before insert or update of org_id, resource_type, resource_id on drive_retention_holds
for each row execute function helix_validate_drive_retention_hold();

alter table drive_retention_holds enable row level security;
alter table drive_retention_holds force row level security;
create policy drive_retention_holds_tenant on drive_retention_holds
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

alter function helix_set_drive_trash_deadline() owner to helix_migration_owner;
alter function helix_validate_drive_retention_hold() owner to helix_migration_owner;
revoke all on drive_retention_holds from public;
grant select, insert, update on drive_retention_holds to helix_app;
grant select on drive_retention_holds to helix_readonly;
