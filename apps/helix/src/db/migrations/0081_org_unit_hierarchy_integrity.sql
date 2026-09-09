-- Keep the denormalized OU breadcrumb consistent with its tenant-scoped tree.

alter table admin_org_units
  add constraint admin_org_units_no_self_parent
  check (parent_id is distinct from id);

-- Every valid tree node must be reachable from a root. Fail rather than carry
-- pre-existing cycles into the path-maintenance trigger.
do $$
declare
  unrooted_count bigint;
begin
  with recursive rooted as (
    select id, org_id
    from admin_org_units
    where parent_id is null

    union all

    select child.id, child.org_id
    from admin_org_units child
    join rooted parent
      on parent.org_id = child.org_id and parent.id = child.parent_id
  )
  select count(*) into unrooted_count
  from admin_org_units unit
  where not exists (
    select 1 from rooted where rooted.org_id = unit.org_id and rooted.id = unit.id
  );

  if unrooted_count > 0 then
    raise check_violation using
      constraint = 'admin_org_units_acyclic',
      message = 'organizational unit hierarchy contains a cycle';
  end if;
end
$$;

with recursive hierarchy as (
  select id, org_id, name as path
  from admin_org_units
  where parent_id is null

  union all

  select child.id, child.org_id, parent.path || ' > ' || child.name
  from admin_org_units child
  join hierarchy parent
    on parent.org_id = child.org_id and parent.id = child.parent_id
)
update admin_org_units unit
set path = hierarchy.path
from hierarchy
where unit.org_id = hierarchy.org_id
  and unit.id = hierarchy.id
  and unit.path is distinct from hierarchy.path;

create function admin_org_units_prepare_write()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  parent_path text;
begin
  -- The descendant refresh below supplies already-calculated paths from inside
  -- its AFTER trigger. All externally initiated writes still traverse the full
  -- invariant checks and derive path from parent + name.
  if TG_OP = 'UPDATE'
    and pg_trigger_depth() > 1
    and new.org_id is not distinct from old.org_id
    and new.parent_id is not distinct from old.parent_id
    and new.name is not distinct from old.name
  then
    return new;
  end if;

  if TG_OP = 'UPDATE' and new.org_id is distinct from old.org_id then
    raise check_violation using
      constraint = 'admin_org_units_org_id_immutable',
      message = 'organizational units cannot move between organizations';
  end if;

  -- Serialize hierarchy changes within one tenant so concurrent reparents
  -- cannot each validate against an obsolete tree.
  perform pg_advisory_xact_lock(hashtextextended(new.org_id::text, 0));

  if new.parent_id is null then
    new.path := new.name;
    return new;
  end if;

  if new.parent_id = new.id then
    raise check_violation using
      constraint = 'admin_org_units_no_self_parent',
      message = 'an organizational unit cannot be its own parent';
  end if;

  select parent.path into parent_path
  from admin_org_units parent
  where parent.org_id = new.org_id and parent.id = new.parent_id;

  if not found then
    raise foreign_key_violation using
      constraint = 'admin_org_units_parent_org_fk',
      message = 'organizational unit parent must belong to the same organization';
  end if;

  if exists (
    with recursive ancestors as (
      select id, parent_id
      from admin_org_units
      where org_id = new.org_id and id = new.parent_id

      union

      select parent.id, parent.parent_id
      from admin_org_units parent
      join ancestors child on child.parent_id = parent.id
      where parent.org_id = new.org_id
    )
    select 1 from ancestors where id = new.id
  ) then
    raise check_violation using
      constraint = 'admin_org_units_acyclic',
      message = 'an organizational unit cannot be moved below its descendant';
  end if;

  new.path := parent_path || ' > ' || new.name;
  return new;
end
$$;

create function admin_org_units_refresh_descendant_paths()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.path is not distinct from old.path then
    return null;
  end if;

  with recursive descendants as (
    select child.id, child.org_id, new.path || ' > ' || child.name as path
    from admin_org_units child
    where child.org_id = new.org_id and child.parent_id = new.id

    union all

    select child.id, child.org_id, parent.path || ' > ' || child.name
    from admin_org_units child
    join descendants parent
      on parent.org_id = child.org_id and parent.id = child.parent_id
  )
  update admin_org_units child
  set path = descendants.path, updated_at = clock_timestamp()
  from descendants
  where child.org_id = descendants.org_id
    and child.id = descendants.id
    and child.path is distinct from descendants.path;

  return null;
end
$$;

create trigger admin_org_units_prepare_write
before insert or update on admin_org_units
for each row execute function admin_org_units_prepare_write();

create trigger admin_org_units_refresh_descendant_paths
after update of parent_id, name on admin_org_units
for each row execute function admin_org_units_refresh_descendant_paths();
