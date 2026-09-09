alter table cal_events
  add column if not exists time_semantics text,
  add column if not exists starts_local text,
  add column if not exists ends_local text;

update cal_events event
set timezone = 'UTC'
where not exists (select 1 from pg_timezone_names zone where zone.name = event.timezone);

update cal_events
set
  time_semantics = case when all_day then 'all_day' else 'zoned' end,
  starts_local = to_char(
    starts_at at time zone case when all_day then 'UTC' else timezone end,
    'YYYY-MM-DD"T"HH24:MI:SS'
  ),
  ends_local = to_char(
    ends_at at time zone case when all_day then 'UTC' else timezone end,
    'YYYY-MM-DD"T"HH24:MI:SS'
  )
where time_semantics is null or starts_local is null or ends_local is null;

alter table cal_events
  alter column time_semantics set default 'zoned',
  alter column time_semantics set not null,
  alter column starts_local set not null,
  alter column ends_local set not null,
  add constraint cal_events_time_semantics_check
    check (time_semantics in ('zoned', 'floating', 'all_day')),
  add constraint cal_events_local_time_shape_check
    check (
      starts_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$'
      and ends_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$'
    ),
  add constraint cal_events_all_day_semantics_check
    check (all_day = (time_semantics = 'all_day'));
