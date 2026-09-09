-- Extension installation needs the migration connection's database privilege;
-- return to the non-login DDL owner before creating application objects.
reset role;
create extension if not exists pg_trgm;
set local role helix_migration_owner;

create table carddav_addressbooks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  owner_actor_id uuid not null,
  display_name text not null default 'Contacts' check (length(btrim(display_name)) between 1 and 255),
  is_default boolean not null default false,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  foreign key (org_id, owner_actor_id) references actors(org_id, id) on delete cascade
);

create unique index carddav_addressbooks_default_owner_idx
  on carddav_addressbooks (org_id, owner_actor_id) where is_default;
-- The migration owner may backfill every tenant; FORCE is restored below before
-- runtime grants remain in effect.
alter table carddav_contacts no force row level security;

create index carddav_addressbooks_owner_idx on carddav_addressbooks (org_id, owner_actor_id, id);

insert into carddav_addressbooks (org_id, owner_actor_id, is_default)
select owner.org_id, owner.id, true
from actors owner
where owner.type = 'user'
   or exists (select 1 from carddav_contacts contact where contact.owner_actor_id = owner.id)
on conflict (org_id, owner_actor_id) where is_default do nothing;

create function helix_create_default_carddav_addressbook()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public set row_security = off as $$
begin
  if new.type = 'user' then
    insert into carddav_addressbooks (org_id, owner_actor_id, is_default)
    values (new.org_id, new.id, true)
    on conflict (org_id, owner_actor_id) where is_default do nothing;
  end if;
  return new;
end
$$;

create trigger actors_create_default_carddav_addressbook
after insert on actors for each row execute function helix_create_default_carddav_addressbook();

alter table carddav_contacts
  add column addressbook_id uuid,
  add column purge_after timestamptz,
  add column retain_until timestamptz,
  add column legal_hold boolean not null default false;

update carddav_contacts contact
set addressbook_id = book.id,
    purge_after = case when contact.deleted_at is null then null else contact.deleted_at + interval '30 days' end
from carddav_addressbooks book
where book.org_id = contact.org_id and book.owner_actor_id = contact.owner_actor_id and book.is_default;

alter table carddav_contacts
  alter column addressbook_id set not null,
  add constraint carddav_contacts_addressbook_fk foreign key (addressbook_id)
    references carddav_addressbooks(id) on delete cascade,
  add constraint carddav_contacts_purge_shape check (
    (deleted_at is null and purge_after is null)
    or (deleted_at is not null and purge_after is not null and purge_after >= deleted_at)
  );

drop index carddav_contacts_owner_href_active_idx;
drop index carddav_contacts_owner_active_idx;
drop index carddav_contacts_owner_sync_version_idx;
create unique index carddav_contacts_book_href_active_idx
  on carddav_contacts (addressbook_id, href) where deleted_at is null;
create index carddav_contacts_book_href_idx
  on carddav_contacts (org_id, addressbook_id, href) where deleted_at is null;
create index carddav_contacts_book_sync_idx
  on carddav_contacts (org_id, addressbook_id, sync_version, href);
create index carddav_contacts_name_search_idx
  on carddav_contacts using gin (lower(coalesce(display_name, '')) gin_trgm_ops)
  where deleted_at is null and merged_into_id is null;
create index carddav_contacts_email_search_idx
  on carddav_contacts using gin (lower(coalesce(email, '')) gin_trgm_ops)
  where deleted_at is null and merged_into_id is null and email is not null;
create index carddav_contacts_uid_search_idx
  on carddav_contacts using gin (lower(uid) gin_trgm_ops)
  where deleted_at is null and merged_into_id is null;

create function helix_set_carddav_purge_deadline()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if new.deleted_at is null then
    new.purge_after := null;
  elsif old.deleted_at is null or old.deleted_at is distinct from new.deleted_at then
    new.purge_after := new.deleted_at + interval '30 days';
  end if;
  return new;
end
$$;

create trigger carddav_contacts_set_purge_deadline
before update of deleted_at on carddav_contacts
for each row execute function helix_set_carddav_purge_deadline();

alter table carddav_contacts force row level security;

create function helix_purge_carddav_contacts(input_org_id uuid, input_limit integer)
returns integer language plpgsql security definer
set search_path = pg_catalog, public set row_security = off as $$
declare deleted_count integer;
begin
  if input_limit not between 1 and 10000 then
    raise invalid_parameter_value using message = 'CardDAV purge limit must be between 1 and 10000';
  end if;
  with candidates as (
    select id from carddav_contacts
    where org_id = input_org_id and deleted_at is not null
      and purge_after <= statement_timestamp()
      and not legal_hold
      and (retain_until is null or retain_until <= statement_timestamp())
    order by purge_after, id limit input_limit for update skip locked
  )
  delete from carddav_contacts contact using candidates
  where contact.id = candidates.id;
  get diagnostics deleted_count = row_count;
  if deleted_count > 0 then
    insert into activity (
      org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash
    ) values (
      input_org_id, null, 'carddav.retention.purged', 'carddav.contact', null,
      jsonb_build_object('version', 1, 'deletedCount', deleted_count), null, ''
    );
    insert into outbox (subject, payload) values (
      'activity.carddav.retention.purged',
      jsonb_build_object('version', 1, 'orgId', input_org_id, 'deletedCount', deleted_count)
    );
  end if;
  return deleted_count;
end
$$;

alter table carddav_addressbooks enable row level security;
alter table carddav_addressbooks force row level security;
create policy helix_tenant_isolation on carddav_addressbooks
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());

alter table carddav_addressbooks owner to helix_migration_owner;
alter function helix_set_carddav_purge_deadline() owner to helix_migration_owner;
alter function helix_create_default_carddav_addressbook() owner to helix_migration_owner;
alter function helix_purge_carddav_contacts(uuid, integer) owner to helix_migration_owner;
revoke all on carddav_addressbooks from public, helix_app, helix_worker, helix_readonly;
grant select, insert, update, delete on carddav_addressbooks to helix_app, helix_worker;
grant select on carddav_addressbooks to helix_readonly;
revoke all on function helix_set_carddav_purge_deadline() from public;
revoke all on function helix_create_default_carddav_addressbook() from public;
revoke all on function helix_purge_carddav_contacts(uuid, integer) from public;
grant execute on function helix_purge_carddav_contacts(uuid, integer) to helix_worker;

create or replace function helix_tenant_deletion_blockers(input_org_id uuid)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public set row_security = off as $$
  select coalesce(jsonb_agg(blocker order by blocker->>'type'), '[]'::jsonb)
  from (
    select jsonb_build_object('type', 'mail_hold', 'count', count(*)) blocker
    from mail_retention_holds
    where org_id = input_org_id and (expires_at is null or expires_at > statement_timestamp())
    having count(*) > 0
    union all
    select jsonb_build_object('type', 'drive_hold', 'count', count(*))
    from drive_retention_holds
    where org_id = input_org_id and released_at is null
      and (expires_at is null or expires_at > statement_timestamp())
    having count(*) > 0
    union all
    select jsonb_build_object('type', 'drive_retention', 'count', count(*))
    from (
      select id from objects where org_id = input_org_id and retain_until > statement_timestamp()
      union all
      select id from drive_folders where org_id = input_org_id and retain_until > statement_timestamp()
    ) retained_drive
    having count(*) > 0
    union all
    select jsonb_build_object('type', 'recording_hold_or_retention', 'count', count(*))
    from meet_recording_governance
    where org_id = input_org_id and (legal_hold or retention_until > statement_timestamp())
    having count(*) > 0
    union all
    select jsonb_build_object('type', 'contact_hold_or_retention', 'count', count(*))
    from carddav_contacts
    where org_id = input_org_id and (legal_hold or retain_until > statement_timestamp())
    having count(*) > 0
  ) blockers
$$;

alter function helix_tenant_deletion_blockers(uuid) owner to helix_migration_owner;
revoke all on function helix_tenant_deletion_blockers(uuid) from public;
grant execute on function helix_tenant_deletion_blockers(uuid) to helix_app, helix_worker;
