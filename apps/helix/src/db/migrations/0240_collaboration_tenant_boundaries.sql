-- Keep actor policies intact while enforcing the canonical deployment-wide tenant boundary.
do $$
declare relation_name text;
begin
  foreach relation_name in array array[
    'actor_event_state', 'actor_events', 'actor_status', 'actor_presence_connections',
    'agent_runtimes', 'bot_account_requests', 'bot_account_observers',
    'mail_productivity_preferences', 'mail_productivity_artifacts',
    'meet_transcripts', 'meet_transcript_segments'
  ] loop
    if exists (
      select 1 from pg_policy
      where polrelid = format('public.%I', relation_name)::regclass
        and polname = 'tenant_boundary' and not polpermissive
    ) then
      execute format('alter policy tenant_boundary on public.%I rename to helix_tenant_boundary', relation_name);
    else
      execute format(
        'create policy helix_tenant_boundary on public.%I as restrictive for all using (org_id = public.helix_current_org_id()) with check (org_id = public.helix_current_org_id())',
        relation_name
      );
    end if;
  end loop;
end $$;
