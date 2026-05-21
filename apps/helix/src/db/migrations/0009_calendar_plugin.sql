create table if not exists cal_calendars (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  owner_actor_id uuid not null references actors(id),
  name text not null,
  color text,
  timezone text not null default 'UTC',
  description text,
  metadata jsonb not null default '{}',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cal_calendars_owner_idx on cal_calendars (owner_actor_id, deleted_at);
create index if not exists cal_calendars_org_idx on cal_calendars (org_id);

create table if not exists cal_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  calendar_id uuid not null references cal_calendars(id) on delete cascade,
  thread_id uuid references threads(id) on delete set null,
  uid text not null,
  title text not null,
  description text,
  location text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'UTC',
  all_day boolean not null default false,
  status text not null default 'confirmed',
  recurrence_rule text,
  organizer_actor_id uuid references actors(id),
  organizer_email text,
  ics_sequence integer not null default 0,
  metadata jsonb not null default '{}',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cal_events_valid_time check (ends_at > starts_at)
);

create unique index if not exists cal_events_org_uid_active_idx on cal_events (org_id, uid) where deleted_at is null;
create index if not exists cal_events_calendar_time_idx on cal_events (calendar_id, starts_at, ends_at);
create index if not exists cal_events_org_time_idx on cal_events (org_id, starts_at, ends_at);
create index if not exists cal_events_organizer_idx on cal_events (organizer_actor_id);

create table if not exists cal_attendees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  event_id uuid not null references cal_events(id) on delete cascade,
  actor_id uuid references actors(id),
  email text not null,
  display_name text,
  role text not null default 'required',
  response_status text not null default 'needs_action',
  is_organizer boolean not null default false,
  rsvp_token text not null default gen_random_uuid()::text,
  responded_at timestamptz,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists cal_attendees_event_email_idx on cal_attendees (event_id, lower(email));
create unique index if not exists cal_attendees_rsvp_token_idx on cal_attendees (rsvp_token);
create index if not exists cal_attendees_actor_idx on cal_attendees (actor_id);
create index if not exists cal_attendees_org_email_idx on cal_attendees (org_id, lower(email));
