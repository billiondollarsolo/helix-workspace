alter table chat_room_settings
  add constraint chat_room_settings_governance_metadata_check check (
    coalesce(metadata->>'spaceType', 'conversation') in ('conversation', 'direct', 'announcement', 'project')
    and coalesce(metadata->>'historyPolicy', 'full') in ('full', 'since_join', 'off')
    and (
      not metadata ? 'retentionDays'
      or metadata->'retentionDays' = 'null'::jsonb
      or (
        jsonb_typeof(metadata->'retentionDays') = 'number'
        and (metadata->>'retentionDays')::integer between 1 and 36500
      )
    )
    and (not metadata ? 'legalHold' or jsonb_typeof(metadata->'legalHold') = 'boolean')
    and coalesce(metadata->>'notificationPolicy', 'all') in ('all', 'mentions', 'none')
    and coalesce(metadata->>'externalAccess', 'guests') in ('internal', 'guests', 'federated')
  );

-- One history/retention predicate is shared by history, thread, search, and export.
create function helix_chat_message_visible_to(
  input_org_id uuid,
  input_actor_id uuid,
  input_room_id uuid,
  input_sent_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select exists (
    select 1
    from public.permissions permission
    join public.chat_room_settings settings
      on settings.org_id = permission.org_id
     and settings.thread_id = permission.resource_id
    where public.chat_permission_is_valid(
      permission, input_org_id, input_actor_id, input_room_id
    )
      and (
        coalesce(settings.metadata->>'historyPolicy', 'full') = 'full'
        or (
          coalesce(settings.metadata->>'historyPolicy', 'full') = 'since_join'
          and input_sent_at >= permission.valid_from
        )
      )
      and (
        coalesce((settings.metadata->>'legalHold')::boolean, false)
        or nullif(settings.metadata->>'retentionDays', '') is null
        or input_sent_at >= statement_timestamp()
          - make_interval(days => (settings.metadata->>'retentionDays')::integer)
      )
  )
$$;

alter function helix_chat_message_visible_to(uuid, uuid, uuid, timestamptz)
  owner to helix_migration_owner;
revoke all on function helix_chat_message_visible_to(uuid, uuid, uuid, timestamptz) from public;
grant execute on function helix_chat_message_visible_to(uuid, uuid, uuid, timestamptz)
  to helix_app, helix_worker;
