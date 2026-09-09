alter table carddav_contacts
  add column favorite boolean not null default false,
  add column avatar_data_url text,
  add column relationship jsonb not null default '{}'::jsonb,
  add column merged_into_id uuid references carddav_contacts(id) on delete set null,
  add constraint carddav_contacts_relationship_object check (jsonb_typeof(relationship) = 'object'),
  add constraint carddav_contacts_avatar_bounded check (
    avatar_data_url is null or (
      octet_length(avatar_data_url) <= 350000
      and avatar_data_url ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$'
    )
  );

create index carddav_contacts_owner_favorite_idx
  on carddav_contacts (org_id, owner_actor_id, favorite desc, lower(display_name))
  where deleted_at is null and merged_into_id is null;

create function helix_validate_people_contact_tenant()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if not exists (
    select 1 from actors actor
    where actor.org_id = new.org_id and actor.id = new.owner_actor_id
  ) or (new.merged_into_id is not null and not exists (
    select 1 from carddav_contacts target
    where target.org_id = new.org_id
      and target.owner_actor_id = new.owner_actor_id
      and target.id = new.merged_into_id
      and target.deleted_at is null
  )) then
    raise check_violation using message = 'invalid tenant contact relationship';
  end if;
  return new;
end
$$;

create trigger carddav_contacts_people_tenant
before insert or update on carddav_contacts
for each row execute function helix_validate_people_contact_tenant();

alter table carddav_contacts enable row level security;
alter table carddav_contacts force row level security;
drop policy if exists helix_tenant_isolation on carddav_contacts;
create policy helix_tenant_isolation on carddav_contacts
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());

alter table carddav_contacts owner to helix_migration_owner;
alter function helix_validate_people_contact_tenant() owner to helix_migration_owner;
revoke all on carddav_contacts from public, helix_app, helix_worker, helix_readonly;
revoke all on function helix_validate_people_contact_tenant() from public;
grant select, insert, update, delete on carddav_contacts to helix_app, helix_worker;
grant select on carddav_contacts to helix_readonly;
