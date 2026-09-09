alter table meet_rooms
  add column join_code text,
  add column guest_policy text not null default 'disabled',
  add column guest_domains text[] not null default '{}',
  add column lobby_enabled boolean not null default true;

update meet_rooms
set join_code = concat(
  substr(encode(digest(id::text, 'sha256'), 'hex'), 1, 4), '-',
  substr(encode(digest(id::text, 'sha256'), 'hex'), 5, 4), '-',
  substr(encode(digest(id::text, 'sha256'), 'hex'), 9, 4)
)
where join_code is null;

alter table meet_rooms
  alter column join_code set not null,
  add constraint meet_rooms_join_code_shape_check
    check (join_code ~ '^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$'),
  add constraint meet_rooms_guest_policy_check
    check (guest_policy in ('disabled', 'invite', 'domain')),
  add constraint meet_rooms_guest_domains_check
    check (
      guest_policy = 'domain'
      or cardinality(guest_domains) = 0
    );

create unique index meet_rooms_org_join_code_idx on meet_rooms (org_id, join_code);

create table meet_guest_invites (
  id uuid primary key,
  org_id uuid not null,
  room_id uuid not null,
  email text not null check (email = lower(btrim(email)) and email like '%@%'),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by_actor_id uuid not null,
  created_at timestamptz not null default now(),
  constraint meet_guest_invites_room_org_fk
    foreign key (org_id, room_id) references meet_rooms (org_id, id) on delete cascade,
  constraint meet_guest_invites_actor_org_fk
    foreign key (org_id, created_by_actor_id) references actors (org_id, id)
);

create index meet_guest_invites_active_idx
  on meet_guest_invites (org_id, room_id, expires_at)
  where revoked_at is null;

alter table meet_guest_invites enable row level security;
alter table meet_guest_invites force row level security;
create policy helix_tenant_isolation on meet_guest_invites
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

revoke all on meet_guest_invites from public;
grant select, insert, update on meet_guest_invites to helix_app, helix_worker;
