-- Directory relationships never cross organization boundaries, including for
-- direct SQL callers that bypass the service layer.

create unique index if not exists actors_org_id_id_unique_idx
  on actors (org_id, id);
create unique index if not exists admin_org_units_org_id_id_unique_idx
  on admin_org_units (org_id, id);
create unique index if not exists admin_groups_org_id_id_unique_idx
  on admin_groups (org_id, id);

alter table admin_org_units
  drop constraint if exists admin_org_units_parent_id_fkey;
alter table admin_groups
  drop constraint if exists admin_groups_org_unit_id_fkey;
alter table admin_group_members
  drop constraint if exists admin_group_members_group_id_fkey;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'admin_org_units_parent_org_fk'
  ) then
    alter table admin_org_units
      add constraint admin_org_units_parent_org_fk
      foreign key (org_id, parent_id) references admin_org_units (org_id, id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'admin_groups_org_unit_org_fk'
  ) then
    alter table admin_groups
      add constraint admin_groups_org_unit_org_fk
      foreign key (org_id, org_unit_id) references admin_org_units (org_id, id)
      on delete set null (org_unit_id);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'admin_group_members_group_org_fk'
  ) then
    alter table admin_group_members
      add constraint admin_group_members_group_org_fk
      foreign key (org_id, group_id) references admin_groups (org_id, id) on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'admin_group_members_actor_org_fk'
  ) then
    alter table admin_group_members
      add constraint admin_group_members_actor_org_fk
      foreign key (org_id, actor_id) references actors (org_id, id) on delete cascade;
  end if;
end
$$;

-- A composite FK proves actor existence and tenant ownership. This trigger
-- adds the one predicate a foreign key cannot express: the actor is active.
create or replace function admin_group_members_require_active_actor()
returns trigger
language plpgsql
as $$
begin
  perform 1
  from actors
  where org_id = new.org_id
    and id = new.actor_id
    and disabled_at is null;

  if not found then
    raise foreign_key_violation using
      constraint = 'admin_group_members_active_actor_fk',
      message = 'group members must be active actors in the same organization';
  end if;

  return new;
end
$$;

drop trigger if exists admin_group_members_require_active_actor on admin_group_members;
create trigger admin_group_members_require_active_actor
before insert or update of org_id, actor_id on admin_group_members
for each row execute function admin_group_members_require_active_actor();
