-- Drive trash deadlines follow the organization's configured retention.
--
-- 0142 stamped every trashed object and folder with `deleted_at + 30 days`,
-- ignoring `drive_lifecycle_policies.trash_retention_days`. The deadline is
-- now read from the trashed row's own organization (30 days when unset) at the
-- moment it is trashed, so a later policy change applies to newly trashed
-- items and never shortens a recovery window already promised.

create or replace function helix_drive_trash_retention_days(input_org_id uuid)
returns integer
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select coalesce(
    (select policy.trash_retention_days
     from drive_lifecycle_policies policy
     where policy.org_id = input_org_id),
    30
  );
$$;

alter function helix_drive_trash_retention_days(uuid) owner to helix_migration_owner;
revoke all on function helix_drive_trash_retention_days(uuid) from public;
grant execute on function helix_drive_trash_retention_days(uuid) to helix_app, helix_worker;

create or replace function helix_set_drive_trash_deadline()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.deleted_at is null then
    new.trash_purge_after := null;
  elsif old.deleted_at is null or old.deleted_at is distinct from new.deleted_at then
    new.trash_purge_after :=
      new.deleted_at + make_interval(days => helix_drive_trash_retention_days(new.org_id));
  end if;
  return new;
end
$$;

-- Items still in trash keep the longer of their current deadline and the
-- configured one, so no recovery window shrinks.
update objects object
set trash_purge_after = greatest(
  object.trash_purge_after,
  object.deleted_at + make_interval(days => helix_drive_trash_retention_days(object.org_id))
)
where object.deleted_at is not null;

update drive_folders folder
set trash_purge_after = greatest(
  folder.trash_purge_after,
  folder.deleted_at + make_interval(days => helix_drive_trash_retention_days(folder.org_id))
)
where folder.deleted_at is not null;
