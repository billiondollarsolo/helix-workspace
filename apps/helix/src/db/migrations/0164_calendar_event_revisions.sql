create table cal_event_revisions (
  org_id uuid not null,
  event_id uuid not null,
  revision integer not null check (revision >= 0),
  calendar_id uuid not null,
  change_kind text not null check (change_kind in ('created', 'updated', 'cancelled', 'responded', 'restored')),
  changed_by_actor_id uuid,
  snapshot jsonb not null check (
    jsonb_typeof(snapshot) = 'object'
    and jsonb_typeof(snapshot -> 'event') = 'object'
    and jsonb_typeof(snapshot -> 'attendees') = 'array'
    and octet_length(snapshot::text) <= 1048576
  ),
  created_at timestamptz not null default statement_timestamp(),
  primary key (org_id, event_id, revision)
);

create index cal_event_revisions_org_calendar_created_idx
  on cal_event_revisions (org_id, calendar_id, created_at desc, event_id, revision desc);

insert into cal_event_revisions (
  org_id, event_id, revision, calendar_id, change_kind, changed_by_actor_id, snapshot, created_at
)
select event.org_id, event.id, event.ics_sequence, event.calendar_id,
  case
    when event.deleted_at is not null then 'cancelled'
    when event.ics_sequence = 0 then 'created'
    else 'updated'
  end,
  event.organizer_actor_id,
  jsonb_build_object(
    'event', to_jsonb(event),
    'attendees', coalesce((
      select jsonb_agg(to_jsonb(attendee) order by attendee.is_organizer desc, attendee.email)
      from cal_attendees attendee
      where attendee.org_id = event.org_id and attendee.event_id = event.id
    ), '[]'::jsonb)
  ),
  event.updated_at
from cal_events event;

create function helix_calendar_event_revision_immutable()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  raise insufficient_privilege using message = 'Calendar event revisions are append-only';
end
$$;

create trigger cal_event_revisions_immutable
before update or delete on cal_event_revisions
for each row execute function helix_calendar_event_revision_immutable();

alter table cal_event_revisions enable row level security;
alter table cal_event_revisions force row level security;
create policy helix_tenant_isolation on cal_event_revisions
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

alter table cal_event_revisions owner to helix_migration_owner;
alter function helix_calendar_event_revision_immutable() owner to helix_migration_owner;
revoke all on cal_event_revisions from public, helix_app, helix_worker, helix_readonly;
revoke all on function helix_calendar_event_revision_immutable() from public;
grant select, insert on cal_event_revisions to helix_app, helix_worker;
grant select on cal_event_revisions to helix_readonly;
