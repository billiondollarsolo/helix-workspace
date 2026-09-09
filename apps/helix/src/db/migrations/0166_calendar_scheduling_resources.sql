create table cal_scheduling_profiles (
  org_id uuid not null,
  actor_id uuid not null references actors(id) on delete cascade,
  timezone text not null default 'UTC',
  work_days integer[] not null default '{1,2,3,4,5}',
  work_start time not null default '09:00',
  work_end time not null default '17:00',
  work_location text,
  external_availability text not null default 'none'
    check (external_availability in ('none', 'busy')),
  holiday_calendar_id uuid references cal_calendars(id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (org_id, actor_id),
  check (work_days <@ array[0,1,2,3,4,5,6] and cardinality(work_days) between 1 and 7),
  check (work_start < work_end),
  check (octet_length(coalesce(work_location, '')) <= 512)
);

create table cal_resources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  calendar_id uuid not null references cal_calendars(id) on delete cascade,
  name text not null check (length(name) between 1 and 200),
  kind text not null check (kind in ('room', 'equipment')),
  timezone text not null default 'UTC',
  capacity integer check (capacity is null or capacity > 0),
  approval_policy text not null default 'auto' check (approval_policy in ('auto', 'manual')),
  approver_actor_id uuid references actors(id) on delete restrict,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (org_id, id),
  unique (org_id, calendar_id),
  check (approval_policy = 'auto' or approver_actor_id is not null)
);

create table cal_resource_bookings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  resource_id uuid not null,
  event_id uuid not null references cal_events(id) on delete cascade,
  recurrence_id timestamptz,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by_actor_id uuid not null references actors(id) on delete restrict,
  decided_by_actor_id uuid references actors(id) on delete restrict,
  decided_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  foreign key (org_id, resource_id) references cal_resources(org_id, id) on delete cascade,
  unique (org_id, event_id, resource_id, starts_at),
  check (starts_at < ends_at),
  check (status <> 'pending' or decided_at is null)
);

create index cal_resources_org_kind_idx on cal_resources (org_id, kind, active, name);
create index cal_resource_bookings_event_idx on cal_resource_bookings (org_id, event_id);
create index cal_resource_bookings_pending_idx
  on cal_resource_bookings (org_id, resource_id, created_at) where status = 'pending';

create function helix_prevent_resource_booking_overlap()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if new.status = 'approved' then
    perform pg_advisory_xact_lock(hashtextextended(new.resource_id::text, 0));
    if exists (
      select 1 from cal_resource_bookings booking
      where booking.resource_id = new.resource_id and booking.status = 'approved'
        and booking.id <> new.id
        and tstzrange(booking.starts_at, booking.ends_at, '[)')
          && tstzrange(new.starts_at, new.ends_at, '[)')
    ) then
      raise exclusion_violation using message = 'calendar resource is already booked';
    end if;
  end if;
  return new;
end
$$;

create trigger cal_resource_bookings_no_overlap
before insert or update of status, starts_at, ends_at, resource_id on cal_resource_bookings
for each row execute function helix_prevent_resource_booking_overlap();

create function helix_validate_calendar_scheduling_tenant()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_table_name = 'cal_scheduling_profiles' then
    if not exists (select 1 from actors where id = new.actor_id and org_id = new.org_id and disabled_at is null)
      or (new.holiday_calendar_id is not null and not exists (
        select 1 from cal_calendars where id = new.holiday_calendar_id and org_id = new.org_id and deleted_at is null
      )) then raise check_violation using message = 'invalid tenant scheduling profile'; end if;
  elsif tg_table_name = 'cal_resources' then
    if not exists (select 1 from cal_calendars where id = new.calendar_id and org_id = new.org_id and deleted_at is null)
      or (new.approver_actor_id is not null and not exists (
        select 1 from actors where id = new.approver_actor_id and org_id = new.org_id and disabled_at is null
      )) then raise check_violation using message = 'invalid tenant calendar resource'; end if;
  else
    if not exists (select 1 from cal_events where id = new.event_id and org_id = new.org_id)
      or not exists (select 1 from actors where id = new.requested_by_actor_id and org_id = new.org_id and disabled_at is null)
      or (new.decided_by_actor_id is not null and not exists (
        select 1 from actors where id = new.decided_by_actor_id and org_id = new.org_id and disabled_at is null
      )) then raise check_violation using message = 'invalid tenant resource booking'; end if;
    if tg_op = 'UPDATE' and (
      new.org_id, new.resource_id, new.event_id, new.starts_at, new.ends_at, new.requested_by_actor_id
    ) is distinct from (
      old.org_id, old.resource_id, old.event_id, old.starts_at, old.ends_at, old.requested_by_actor_id
    ) then raise check_violation using message = 'resource booking identity is immutable'; end if;
    if tg_op = 'UPDATE' and old.status = 'pending' and new.status in ('approved', 'rejected')
      and (new.decided_by_actor_id is distinct from helix_current_actor_id() or not exists (
        select 1 from cal_resources resource
        where resource.org_id = new.org_id and resource.id = new.resource_id
          and resource.approval_policy = 'manual'
          and resource.approver_actor_id = helix_current_actor_id()
      )) then raise insufficient_privilege using message = 'resource approval requires assigned approver'; end if;
  end if;
  return new;
end
$$;

create trigger cal_scheduling_profiles_tenant
before insert or update on cal_scheduling_profiles
for each row execute function helix_validate_calendar_scheduling_tenant();
create trigger cal_resources_tenant
before insert or update on cal_resources
for each row execute function helix_validate_calendar_scheduling_tenant();
create trigger cal_resource_bookings_tenant
before insert or update on cal_resource_bookings
for each row execute function helix_validate_calendar_scheduling_tenant();

alter table cal_scheduling_profiles enable row level security;
alter table cal_scheduling_profiles force row level security;
alter table cal_resources enable row level security;
alter table cal_resources force row level security;
alter table cal_resource_bookings enable row level security;
alter table cal_resource_bookings force row level security;
create policy helix_tenant_isolation on cal_scheduling_profiles
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());
create policy helix_tenant_isolation on cal_resources
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());
create policy helix_tenant_isolation on cal_resource_bookings
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());

alter table cal_scheduling_profiles owner to helix_migration_owner;
alter table cal_resources owner to helix_migration_owner;
alter table cal_resource_bookings owner to helix_migration_owner;
alter function helix_validate_calendar_scheduling_tenant() owner to helix_migration_owner;
alter function helix_prevent_resource_booking_overlap() owner to helix_migration_owner;
revoke all on cal_scheduling_profiles, cal_resources, cal_resource_bookings from public, helix_app, helix_worker, helix_readonly;
revoke all on function helix_validate_calendar_scheduling_tenant() from public;
revoke all on function helix_prevent_resource_booking_overlap() from public;
grant select, insert, update on cal_scheduling_profiles, cal_resources, cal_resource_bookings to helix_app, helix_worker;
grant select on cal_scheduling_profiles, cal_resources, cal_resource_bookings to helix_readonly;
