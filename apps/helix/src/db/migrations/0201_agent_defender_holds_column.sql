-- RETURNS TABLE column names collided with mail_thread_state.thread_id in the
-- lateral join. Prefer table columns over PL/pgSQL OUT variables.
create or replace function helix_agent_defender_list_holds(
  input_org_id uuid,
  input_operator_id uuid
)
returns table (
  agent_actor_id uuid,
  thread_id uuid,
  held_at timestamptz,
  subject text,
  from_address text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
#variable_conflict use_column
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_operator_id
  then
    raise insufficient_privilege using message = 'Defender holds require the current actor';
  end if;
  return query
  select
    state.actor_id,
    state.thread_id,
    state.held_at,
    coalesce(thread.subject, ''),
    coalesce(message.metadata->'from'->>'address', '')
  from public.mail_thread_state state
  join public.agent_defender_policies policy
    on policy.org_id = state.org_id and policy.actor_id = state.actor_id
  join public.threads thread
    on thread.id = state.thread_id and thread.org_id = state.org_id
  left join lateral (
    select metadata
    from public.messages
    where org_id = state.org_id and thread_id = state.thread_id and kind = 'mail'
    order by sent_at desc
    limit 1
  ) message on true
  where state.org_id = input_org_id
    and policy.owner_actor_id = input_operator_id
    and state.held_at is not null
    and state.deleted_at is null
  order by state.held_at desc;
end;
$$;
alter function helix_agent_defender_list_holds(uuid, uuid)
  owner to helix_migration_owner;
revoke all on function helix_agent_defender_list_holds(uuid, uuid) from public;
grant execute on function helix_agent_defender_list_holds(uuid, uuid) to helix_app;
