-- Durable SCIM correlation and optimistic-concurrency state.  SCIM resources
-- are the existing actors/admin groups; no parallel identity model.

alter table actors
  add column if not exists scim_external_id text,
  add column if not exists scim_version bigint not null default 1
    check (scim_version > 0);

alter table admin_groups
  add column if not exists scim_external_id text,
  add column if not exists scim_version bigint not null default 1
    check (scim_version > 0);

alter table actors
  drop constraint if exists actors_scim_external_id_not_blank;
alter table actors
  add constraint actors_scim_external_id_not_blank
  check (scim_external_id is null or char_length(btrim(scim_external_id)) between 1 and 255);

alter table admin_groups
  drop constraint if exists admin_groups_scim_external_id_not_blank;
alter table admin_groups
  add constraint admin_groups_scim_external_id_not_blank
  check (scim_external_id is null or char_length(btrim(scim_external_id)) between 1 and 255);

create unique index if not exists actors_scim_external_id_idx
  on actors (org_id, lower(scim_external_id))
  where scim_external_id is not null;

create unique index if not exists admin_groups_scim_external_id_idx
  on admin_groups (org_id, lower(scim_external_id))
  where scim_external_id is not null;

-- SCIM userName comparison is case-insensitive.  Enforce the same rule at the
-- database boundary so concurrent provisioners cannot create aliases that
-- differ only by case.
create unique index if not exists actors_scim_username_idx
  on actors (org_id, lower(email))
  where type = 'user' and email is not null;

-- Versions cover changes made through both SCIM and the native admin surface.
-- Otherwise an admin edit could leave an already-issued If-Match value valid.
create or replace function scim_bump_actor_version()
returns trigger
language plpgsql
as $$
begin
  if row(new.email, new.display_name, new.disabled_at, new.scim_external_id,
         new.metadata->'scim') is distinct from
     row(old.email, old.display_name, old.disabled_at, old.scim_external_id,
         old.metadata->'scim') then
    new.scim_version := old.scim_version + 1;
    new.updated_at := now();
  end if;
  return new;
end
$$;

drop trigger if exists actors_scim_version on actors;
create trigger actors_scim_version
before update of email, display_name, disabled_at, scim_external_id, metadata on actors
for each row execute function scim_bump_actor_version();

create or replace function scim_bump_group_version()
returns trigger
language plpgsql
as $$
begin
  if row(new.name, new.scim_external_id) is distinct from
     row(old.name, old.scim_external_id) then
    new.scim_version := old.scim_version + 1;
    new.updated_at := now();
  end if;
  return new;
end
$$;

drop trigger if exists admin_groups_scim_version on admin_groups;
create trigger admin_groups_scim_version
before update of name, scim_external_id on admin_groups
for each row execute function scim_bump_group_version();

create or replace function scim_bump_group_membership_version()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    update admin_groups
    set scim_version = scim_version + 1, updated_at = now()
    where org_id = new.org_id and id = new.group_id;
    return new;
  elsif tg_op = 'DELETE' then
    update admin_groups
    set scim_version = scim_version + 1, updated_at = now()
    where org_id = old.org_id and id = old.group_id;
    return old;
  end if;

  update admin_groups
  set scim_version = scim_version + 1, updated_at = now()
  where org_id = old.org_id and id = old.group_id;
  if row(new.org_id, new.group_id) is distinct from row(old.org_id, old.group_id) then
    update admin_groups
    set scim_version = scim_version + 1, updated_at = now()
    where org_id = new.org_id and id = new.group_id;
  end if;
  return new;
end
$$;

drop trigger if exists admin_group_members_scim_version on admin_group_members;
create trigger admin_group_members_scim_version
after insert or update or delete on admin_group_members
for each row execute function scim_bump_group_membership_version();
