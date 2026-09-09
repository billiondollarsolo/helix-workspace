alter table cal_calendars
  add column sync_version bigint not null default 0,
  add constraint cal_calendars_sync_version_nonnegative check (sync_version >= 0);

create table cal_event_changes (
  org_id uuid not null,
  calendar_id uuid not null,
  sync_version bigint not null,
  event_id uuid not null,
  deleted boolean not null,
  changed_at timestamptz not null default statement_timestamp(),
  primary key (calendar_id, sync_version),
  foreign key (org_id, calendar_id) references cal_calendars(org_id, id) on delete cascade,
  check (sync_version > 0)
);

create index cal_event_changes_org_calendar_version_idx
  on cal_event_changes (org_id, calendar_id, sync_version);

-- Give existing resources an ordered initial-sync history. The event id is
-- intentionally not an FK: a tombstone must outlive a hard-deleted resource.
with initial_changes as (
  select
    event.org_id,
    event.calendar_id,
    row_number() over (
      partition by event.calendar_id order by event.created_at, event.id
    )::bigint as sync_version,
    event.id as event_id,
    event.deleted_at is not null as deleted,
    event.updated_at as changed_at
  from cal_events event
)
insert into cal_event_changes (
  org_id, calendar_id, sync_version, event_id, deleted, changed_at
)
select org_id, calendar_id, sync_version, event_id, deleted, changed_at
from initial_changes;

update cal_calendars calendar
set sync_version = coalesce(change.max_version, 0)
from (
  select calendar_id, max(sync_version) as max_version
  from cal_event_changes
  group by calendar_id
) change
where calendar.id = change.calendar_id;

create function helix_record_calendar_event_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  event_row cal_events;
  next_version bigint;
begin
  event_row := case when tg_op = 'DELETE' then old else new end;

  update cal_calendars
  set sync_version = sync_version + 1
  where org_id = event_row.org_id and id = event_row.calendar_id
  returning sync_version into next_version;

  -- A cascading calendar delete removes its log with the collection. There is
  -- no collection left to synchronize, so no tombstone is needed in that case.
  if next_version is null then
    return event_row;
  end if;

  insert into cal_event_changes (
    org_id, calendar_id, sync_version, event_id, deleted
  ) values (
    event_row.org_id,
    event_row.calendar_id,
    next_version,
    event_row.id,
    tg_op = 'DELETE' or event_row.deleted_at is not null
  );
  return event_row;
end
$$;

create trigger cal_events_record_sync_change
after insert or update or delete on cal_events
for each row execute function helix_record_calendar_event_change();

alter table cal_event_changes enable row level security;
alter table cal_event_changes force row level security;
create policy helix_tenant_isolation on cal_event_changes
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

revoke all on cal_event_changes from public, helix_app, helix_worker, helix_readonly;
grant select on cal_event_changes to helix_app, helix_worker;
revoke all on function helix_record_calendar_event_change() from public;
