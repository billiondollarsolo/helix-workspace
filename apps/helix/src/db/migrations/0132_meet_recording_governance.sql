create table meet_recording_governance (
  org_id uuid not null,
  object_id uuid not null,
  room_id uuid not null,
  thread_id uuid not null,
  owner_actor_id uuid,
  classification text not null default 'standard'
    check (classification in ('public', 'standard', 'confidential', 'restricted')),
  region text not null,
  retention_until timestamptz,
  legal_hold boolean not null default false,
  export_allowed boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, object_id),
  foreign key (org_id, object_id) references objects (org_id, id) on delete cascade,
  foreign key (org_id, room_id) references meet_rooms (org_id, id) on delete cascade,
  foreign key (org_id, thread_id) references threads (org_id, id) on delete cascade,
  foreign key (org_id, owner_actor_id) references actors (org_id, id)
);

create index meet_recording_governance_room_idx
  on meet_recording_governance (org_id, room_id, object_id);

alter table meet_recording_governance enable row level security;
alter table meet_recording_governance force row level security;
create policy helix_tenant_isolation on meet_recording_governance
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

revoke all on meet_recording_governance from public, helix_readonly;
grant select, insert, update on meet_recording_governance to helix_app, helix_worker;

-- Recording viewers inherit the live meeting/thread grants. Remove the copied
-- grants created by the earlier implementation so revocation takes effect.
delete from permissions permission
using objects object
where permission.org_id = object.org_id
  and permission.resource_type = 'object'
  and permission.resource_id = object.id
  and object.kind = 'recording'
  and permission.actor_id is distinct from object.owner_actor_id;
