alter table meet_rooms
  add column host_actor_id uuid,
  add column cohost_actor_ids uuid[] not null default '{}',
  add column locked boolean not null default false,
  add column mute_policy text not null default 'open',
  add column presenter_policy text not null default 'everyone',
  add column presenter_subject text,
  add column chat_policy text not null default 'everyone',
  add column reaction_policy text not null default 'everyone',
  add column admitted_participant_subjects text[] not null default '{}',
  add column banned_participant_subjects text[] not null default '{}',
  add column control_version bigint not null default 1;

update meet_rooms
set host_actor_id = created_by_actor_id,
    admitted_participant_subjects = case
      when created_by_actor_id is null then '{}'
      else array[created_by_actor_id::text]
    end;

alter table meet_rooms
  add constraint meet_rooms_host_actor_fk
    foreign key (org_id, host_actor_id) references actors (org_id, id),
  add constraint meet_rooms_active_host_check
    check (status = 'ended' or host_actor_id is not null),
  add constraint meet_rooms_mute_policy_check
    check (mute_policy in ('open', 'moderated')),
  add constraint meet_rooms_presenter_policy_check
    check (presenter_policy in ('everyone', 'hosts', 'selected')),
  add constraint meet_rooms_presenter_shape_check
    check ((presenter_policy = 'selected') = (presenter_subject is not null)),
  add constraint meet_rooms_chat_policy_check
    check (chat_policy in ('everyone', 'hosts', 'disabled')),
  add constraint meet_rooms_reaction_policy_check
    check (reaction_policy in ('everyone', 'hosts', 'disabled')),
  add constraint meet_rooms_control_subject_limit_check
    check (
      cardinality(cohost_actor_ids) <= 50
      and cardinality(admitted_participant_subjects) <= 1000
      and cardinality(banned_participant_subjects) <= 1000
    ),
  add constraint meet_rooms_control_version_check check (control_version > 0);

create table meet_control_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  room_id uuid not null,
  actor_id uuid not null,
  action text not null check (action in (
    'lobby.set', 'participant.admit', 'meeting.lock', 'participant.remove',
    'participant.ban', 'mute-policy.set', 'presenter-policy.set',
    'cohost.add', 'cohost.remove', 'chat-policy.set', 'reaction-policy.set',
    'host.transfer'
  )),
  target_subject text,
  control_version bigint not null check (control_version > 1),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (org_id, room_id) references meet_rooms (org_id, id) on delete cascade,
  foreign key (org_id, actor_id) references actors (org_id, id)
);

create index meet_control_events_room_time_idx
  on meet_control_events (org_id, room_id, created_at, id);

alter table meet_control_events enable row level security;
alter table meet_control_events force row level security;
create policy helix_tenant_isolation on meet_control_events
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

create function helix_meet_control_events_immutable()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  raise exception 'meet control events are append-only' using errcode = '23000';
end
$$;

create trigger meet_control_events_no_update_or_delete
before update or delete on meet_control_events
for each row execute function helix_meet_control_events_immutable();

revoke all on meet_control_events from public, helix_readonly;
grant select, insert on meet_control_events to helix_app, helix_worker;
