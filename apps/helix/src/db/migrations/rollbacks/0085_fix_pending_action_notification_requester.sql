do $$
begin
  raise exception
    'cannot roll back 0085: the previous trigger referenced nonexistent pending_actions.requester_actor_id';
end;
$$;
