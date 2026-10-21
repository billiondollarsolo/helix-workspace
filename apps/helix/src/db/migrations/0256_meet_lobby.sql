-- Meet lobby: a guest joining a meeting with the lobby on waits here until a
-- host or co-host lets them in or turns them away. A waiting guest gets no
-- media token. Requests whose guest stopped checking in drop out of the
-- host's list (last_seen_at).
create table meet_lobby_requests (
  org_id uuid not null,
  room_id uuid not null,
  participant_subject text not null check (length(participant_subject) between 1 and 200),
  display_name text not null check (length(display_name) between 1 and 200),
  status text not null default 'waiting' check (status in ('waiting', 'admitted', 'denied')),
  requested_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  decided_by_actor_id uuid,
  decided_at timestamptz,
  primary key (org_id, room_id, participant_subject),
  constraint meet_lobby_requests_room_org_fk
    foreign key (org_id, room_id) references meet_rooms (org_id, id) on delete cascade,
  check ((status = 'waiting') = (decided_at is null))
);

create index meet_lobby_requests_waiting_idx
  on meet_lobby_requests (org_id, room_id, last_seen_at)
  where status = 'waiting';

alter table meet_lobby_requests enable row level security;
alter table meet_lobby_requests force row level security;
create policy helix_tenant_isolation on meet_lobby_requests
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
create policy helix_tenant_boundary on meet_lobby_requests as restrictive for all
  using (org_id = public.helix_current_org_id())
  with check (org_id = public.helix_current_org_id());

revoke all on meet_lobby_requests from public;
grant select, insert, update, delete on meet_lobby_requests to helix_app, helix_worker;
