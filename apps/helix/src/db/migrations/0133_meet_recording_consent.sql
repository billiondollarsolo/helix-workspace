alter table meet_rooms
  add column recording_active boolean not null default false,
  add column recording_started_at timestamptz;

alter table meet_media_events drop constraint meet_media_events_event_type_check;
alter table meet_media_events add constraint meet_media_events_event_type_check check (event_type in (
  'conference.started', 'conference.ended', 'participant.joined', 'participant.left',
  'recording.started', 'recording.ended'
));

create table meet_recording_consents (
  id uuid primary key,
  org_id uuid not null,
  room_id uuid not null,
  participant_subject text not null check (char_length(participant_subject) between 1 and 200),
  actor_id uuid,
  guest_invite_id uuid,
  device_id uuid not null,
  notice_version text not null check (char_length(notice_version) between 1 and 40),
  consent_policy text not null check (consent_policy = 'explicit-all-parties'),
  jurisdiction text not null check (jurisdiction = 'global'),
  evidence jsonb not null default '{}'::jsonb,
  consented_at timestamptz not null default now(),
  expires_at timestamptz not null,
  foreign key (org_id, room_id) references meet_rooms (org_id, id) on delete cascade,
  foreign key (org_id, actor_id) references actors (org_id, id),
  check (
    (actor_id is not null and guest_invite_id is null and participant_subject = actor_id::text)
    or
    (actor_id is null and guest_invite_id is not null
      and participant_subject = 'guest:' || guest_invite_id::text)
  ),
  check (expires_at > consented_at)
);

create unique index meet_guest_invites_org_id_id_idx on meet_guest_invites (org_id, id);
alter table meet_recording_consents
  add foreign key (org_id, guest_invite_id)
  references meet_guest_invites (org_id, id);

create index meet_recording_consents_current_idx
  on meet_recording_consents (org_id, room_id, participant_subject, expires_at);

create table meet_recording_authorizations (
  id uuid primary key,
  org_id uuid not null,
  room_id uuid not null,
  authorized_by_actor_id uuid not null,
  participant_subjects text[] not null,
  consent_ids uuid[] not null,
  authorized_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  recording_upload_claimed_at timestamptz,
  foreign key (org_id, room_id) references meet_rooms (org_id, id) on delete cascade,
  foreign key (org_id, authorized_by_actor_id) references actors (org_id, id),
  check (cardinality(participant_subjects) = cardinality(consent_ids)),
  check (cardinality(participant_subjects) > 0),
  check (expires_at > authorized_at)
);

create index meet_recording_authorizations_room_time_idx
  on meet_recording_authorizations (org_id, room_id, authorized_at desc);

alter table meet_recording_consents enable row level security;
alter table meet_recording_consents force row level security;
create policy helix_tenant_isolation on meet_recording_consents
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

alter table meet_recording_authorizations enable row level security;
alter table meet_recording_authorizations force row level security;
create policy helix_tenant_isolation on meet_recording_authorizations
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

revoke all on meet_recording_consents, meet_recording_authorizations
  from public, helix_readonly;
grant select, insert on meet_recording_consents to helix_app, helix_worker;
grant select, insert, update (claimed_at, recording_upload_claimed_at)
  on meet_recording_authorizations
  to helix_app, helix_worker;
