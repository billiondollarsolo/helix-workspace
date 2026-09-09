-- Stars and list/card layout are private membership preferences, never shared
-- object state. A star row's presence means starred; there is no redundant
-- boolean or compatibility column.

create table drive_member_stars (
  org_id uuid not null,
  membership_id uuid not null,
  object_id uuid not null,
  primary key (org_id, membership_id, object_id),
  foreign key (org_id, membership_id)
    references organization_memberships (org_id, id) on delete cascade,
  foreign key (org_id, object_id)
    references objects (org_id, id) on delete cascade
);

create table workspace_member_preferences (
  org_id uuid not null,
  membership_id uuid not null,
  document_surface_view text not null
    check (document_surface_view in ('grid', 'list')),
  primary key (org_id, membership_id),
  foreign key (org_id, membership_id)
    references organization_memberships (org_id, id) on delete cascade
);

-- Preserve the old shared star as each current member's initial preference,
-- then permanently remove object metadata as an authority for this state.
insert into drive_member_stars (org_id, membership_id, object_id)
select object.org_id, membership.id, object.id
from objects object
join organization_memberships membership
  on membership.org_id = object.org_id and membership.status = 'active'
where object.metadata->>'starred' = 'true'
on conflict do nothing;

update objects
set metadata = metadata - 'starred'
where metadata ? 'starred';

alter table objects
  add constraint objects_metadata_no_starred check (not metadata ? 'starred');

alter table drive_member_stars enable row level security;
alter table drive_member_stars force row level security;
create policy drive_member_stars_self on drive_member_stars
  using (
    org_id = helix_current_org_id()
    and membership_id in (
      select membership.id
      from organization_memberships membership
      where membership.org_id = drive_member_stars.org_id
        and membership.actor_id = helix_current_actor_id()
        and membership.status = 'active'
    )
  )
  with check (
    org_id = helix_current_org_id()
    and membership_id in (
      select membership.id
      from organization_memberships membership
      where membership.org_id = drive_member_stars.org_id
        and membership.actor_id = helix_current_actor_id()
        and membership.status = 'active'
    )
  );

alter table workspace_member_preferences enable row level security;
alter table workspace_member_preferences force row level security;
create policy workspace_member_preferences_self on workspace_member_preferences
  using (
    org_id = helix_current_org_id()
    and membership_id in (
      select membership.id
      from organization_memberships membership
      where membership.org_id = workspace_member_preferences.org_id
        and membership.actor_id = helix_current_actor_id()
        and membership.status = 'active'
    )
  )
  with check (
    org_id = helix_current_org_id()
    and membership_id in (
      select membership.id
      from organization_memberships membership
      where membership.org_id = workspace_member_preferences.org_id
        and membership.actor_id = helix_current_actor_id()
        and membership.status = 'active'
    )
  );

alter table drive_member_stars owner to helix_migration_owner;
alter table workspace_member_preferences owner to helix_migration_owner;

revoke all on drive_member_stars, workspace_member_preferences from public;
grant select, insert, delete on drive_member_stars to helix_app;
grant select, insert, update on workspace_member_preferences to helix_app;
