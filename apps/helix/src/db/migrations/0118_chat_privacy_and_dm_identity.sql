alter table chat_room_settings
  add column if not exists privacy text,
  add column if not exists participant_key text;

update chat_room_settings
set privacy = case when is_private then 'private' else 'restricted' end
where privacy is null;

alter table chat_room_settings
  alter column privacy set default 'restricted',
  alter column privacy set not null;

alter table chat_room_settings drop constraint if exists chat_room_settings_privacy_check;
alter table chat_room_settings
  add constraint chat_room_settings_privacy_check
  check (privacy in ('discoverable', 'restricted', 'private'));

alter table chat_room_settings drop column if exists is_private;

create unique index if not exists chat_room_settings_org_participant_key_idx
  on chat_room_settings (org_id, participant_key)
  where participant_key is not null;

create index if not exists chat_room_settings_directory_idx
  on chat_room_settings (org_id, privacy, updated_at desc, thread_id)
  where privacy <> 'private';
