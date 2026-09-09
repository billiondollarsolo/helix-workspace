create function helix_chat_presence_blocked_actor_ids(
  input_org_id uuid,
  input_actor_id uuid,
  input_candidate_actor_ids uuid[]
)
returns table (actor_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select distinct case
    when block.blocker_actor_id = input_actor_id then block.blocked_actor_id
    else block.blocker_actor_id
  end
  from chat_user_blocks block
  where helix_current_org_id() = input_org_id
    and helix_current_actor_id() = input_actor_id
    and block.org_id = input_org_id
    and (
      (block.blocker_actor_id = input_actor_id and block.blocked_actor_id = any(input_candidate_actor_ids))
      or (block.blocked_actor_id = input_actor_id and block.blocker_actor_id = any(input_candidate_actor_ids))
    )
$$;

revoke all on function helix_chat_presence_blocked_actor_ids(uuid, uuid, uuid[]) from public;
grant execute on function helix_chat_presence_blocked_actor_ids(uuid, uuid, uuid[]) to helix_app;
