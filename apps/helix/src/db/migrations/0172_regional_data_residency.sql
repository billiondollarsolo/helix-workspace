-- A database is a physical regional cell. Tenant moves happen by verified
-- export/import into another cell, never by relabeling data in place.

alter table orgs
  add constraint orgs_region_canonical_check
  check (region ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$') not valid;
alter table orgs validate constraint orgs_region_canonical_check;

alter table orgs
  add constraint orgs_byo_storage_region_check
  check (
    coalesce(byo_config->'storage'->>'kind', '') <> 'byo'
    or byo_config->'storage'->>'region' = region
  ) not valid;
alter table orgs validate constraint orgs_byo_storage_region_check;

create function helix_reject_org_region_change()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.region is distinct from old.region then
    raise check_violation using
      message = 'org region is immutable; migrate the tenant to another regional cell';
  end if;
  return new;
end
$$;

revoke all on function helix_reject_org_region_change() from public;

create trigger orgs_region_immutable
before update of region on orgs
for each row execute function helix_reject_org_region_change();
