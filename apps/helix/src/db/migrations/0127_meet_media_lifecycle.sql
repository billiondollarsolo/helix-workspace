alter table meet_rooms
  add column lifecycle_version bigint not null default 0,
  add column active_participant_count integer not null default 0,
  add column empty_since timestamptz,
  add column last_media_event_at timestamptz,
  add constraint meet_rooms_active_participant_count_check
    check (active_participant_count >= 0);

create table meet_media_events (
  event_id text not null check (char_length(event_id) between 1 and 200),
  org_id uuid not null,
  room_id uuid not null,
  event_type text not null check (event_type in (
    'conference.started', 'conference.ended', 'participant.joined', 'participant.left'
  )),
  session_id text check (session_id is null or char_length(session_id) between 1 and 200),
  participant_id text check (participant_id is null or char_length(participant_id) between 1 and 200),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (org_id, event_id),
  foreign key (org_id, room_id) references meet_rooms (org_id, id) on delete cascade,
  check ((event_type like 'participant.%') = (session_id is not null))
);

create index meet_media_events_room_time_idx
  on meet_media_events (org_id, room_id, occurred_at, event_id);

create table meet_participant_sessions (
  org_id uuid not null,
  room_id uuid not null,
  session_id text not null check (char_length(session_id) between 1 and 200),
  participant_id text,
  joined_at timestamptz,
  left_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (org_id, room_id, session_id),
  foreign key (org_id, room_id) references meet_rooms (org_id, id) on delete cascade,
  check (joined_at is not null or left_at is not null)
);

create index meet_participant_sessions_active_idx
  on meet_participant_sessions (org_id, room_id)
  where joined_at is not null and (left_at is null or joined_at > left_at);

alter table meet_media_events enable row level security;
alter table meet_media_events force row level security;
create policy helix_tenant_isolation on meet_media_events
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

alter table meet_participant_sessions enable row level security;
alter table meet_participant_sessions force row level security;
create policy helix_tenant_isolation on meet_participant_sessions
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

revoke all on meet_media_events, meet_participant_sessions from public, helix_readonly;
grant select, insert on meet_media_events to helix_app, helix_worker;
grant select, insert, update on meet_participant_sessions to helix_app, helix_worker;

create function helix_expire_empty_meet_rooms(empty_before timestamptz, batch_limit integer)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  ended_count integer;
begin
  if batch_limit not between 1 and 500 then
    raise exception 'invalid Meet lifecycle batch size';
  end if;
  if nullif(current_setting('helix.org_id', true), '') is not null
    or nullif(current_setting('helix.actor_id', true), '') is not null
  then
    raise insufficient_privilege using
      message = 'Meet lifecycle reconciliation requires an unscoped worker context';
  end if;

  with due as (
    select id
    from public.meet_rooms
    where status = 'active'
      and active_participant_count = 0
      and empty_since is not null
      and empty_since <= empty_before
    order by empty_since, id
    limit batch_limit
    for update skip locked
  ), ended as (
    update public.meet_rooms room set
      status = 'ended',
      ended_at = coalesce(room.ended_at, room.empty_since),
      lifecycle_version = room.lifecycle_version + 1,
      updated_at = now()
    from due
    where room.id = due.id
    returning room.thread_id
  )
  update public.threads thread set
    archived_at = coalesce(thread.archived_at, now()),
    updated_at = now()
  from ended
  where thread.id = ended.thread_id;

  get diagnostics ended_count = row_count;
  return ended_count;
end
$$;

revoke all on function helix_expire_empty_meet_rooms(timestamptz, integer)
  from public, helix_readonly;
grant execute on function helix_expire_empty_meet_rooms(timestamptz, integer)
  to helix_app, helix_worker;
