-- Live transcription on LiveKit: the transcriber resumes meetings whose host
-- asked for transcription and that have no live capture. Exposes IDs only and
-- rejects any active tenant or request context, like the other worker queries.
create function helix_meet_transcription_requested_rooms(batch_limit integer)
returns table(org_id uuid, room_id uuid)
language plpgsql security definer set search_path=pg_catalog,public set row_security=off as $$
begin
  if batch_limit not between 1 and 100 then raise exception 'Invalid transcription batch'; end if;
  if nullif(current_setting('helix.org_id',true),'') is not null or nullif(current_setting('helix.actor_id',true),'') is not null then
    raise exception 'Transcription discovery is restricted to the worker';
  end if;
  return query select r.org_id, r.id from meet_rooms r
    where r.status='active' and r.metadata->>'transcriptionRequested'='true'
      and not exists (
        select 1 from meet_transcripts t
        where t.org_id=r.org_id and t.room_id=r.id and t.status='capturing'
      )
    order by r.updated_at
    limit batch_limit;
end $$;
revoke all on function helix_meet_transcription_requested_rooms(integer) from public,helix_readonly;
grant execute on function helix_meet_transcription_requested_rooms(integer) to helix_app,helix_worker;
