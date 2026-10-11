-- Personal account preferences (language, time zone, formats, week start,
-- working hours and Mail layout) live beside the member's Drive layout
-- preference. NULL means "not chosen": clients follow the browser locale.

alter table workspace_member_preferences
  alter column document_surface_view set default 'grid',
  add column language text,
  add column time_zone text,
  add column date_format text,
  add column time_format text,
  add column week_start smallint,
  add column working_hours jsonb,
  add column mail_reading_pane text not null default 'none',
  add column mail_density text not null default 'default',
  add column mail_conversation_view boolean not null default true,
  add column updated_at timestamptz not null default now(),
  add constraint workspace_member_preferences_language_check
    check (language is null or language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$'),
  add constraint workspace_member_preferences_time_zone_check
    check (time_zone is null or char_length(time_zone) between 1 and 64),
  add constraint workspace_member_preferences_date_format_check
    check (date_format is null or date_format in ('mdy', 'dmy', 'ymd')),
  add constraint workspace_member_preferences_time_format_check
    check (time_format is null or time_format in ('12h', '24h')),
  add constraint workspace_member_preferences_week_start_check
    check (week_start is null or week_start between 0 and 6),
  add constraint workspace_member_preferences_working_hours_check
    check (working_hours is null or jsonb_typeof(working_hours) = 'object'),
  add constraint workspace_member_preferences_mail_reading_pane_check
    check (mail_reading_pane in ('none', 'right', 'below')),
  add constraint workspace_member_preferences_mail_density_check
    check (mail_density in ('default', 'comfortable', 'compact'));
