-- Scope the Chat history predicate to the one room it is asked about.
--
-- helix_chat_message_visible_to filtered permission rows only through
-- chat_permission_is_valid. That function takes the whole row, so the planner
-- could not use its org/actor/room equalities as index conditions and the
-- predicate scanned every permission row in the database, once per call.
-- Search indexing calls it once per room member per message, so indexing one
-- message took up to 0.6 s on a seeded workspace.
--
-- The added equalities are exactly ones chat_permission_is_valid already
-- requires (org, actor, resource type, room, active status), so the result is
-- unchanged for every input; they only let the planner reach the room's rows
-- through permissions_chat_validity_idx and chat_room_settings_pkey.

create or replace function helix_chat_message_visible_to(
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
    where permission.org_id = input_org_id
      and permission.actor_id = input_actor_id
      and permission.resource_type = 'thread'
      and permission.resource_id = input_room_id
      and permission.status = 'active'
      and settings.thread_id = input_room_id
      and public.chat_permission_is_valid(
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
