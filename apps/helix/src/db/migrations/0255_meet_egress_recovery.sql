-- Recovery for Egress recordings whose save was interrupted (for example by a
-- restart). Saving a recording takes a time-limited claim so the webhook and
-- the recovery worker never save the same file twice; a crashed save's claim
-- simply runs out.
alter table meet_recording_uploads add column promoting_until timestamptz;

-- Every organization's unfinished Egress recordings, for the recovery worker.
create function helix_list_pending_meet_egress_recordings(batch_limit integer)
returns table (
  id uuid,
  org_id uuid,
  room_id uuid,
  storage_key text,
  mime_type text,
  egress_id text,
  created_at timestamptz,
  expires_at timestamptz,
  promoting_until timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  if batch_limit not between 1 and 1000 then
    raise exception 'invalid Meet recording recovery batch size';
  end if;
  if nullif(current_setting('helix.org_id', true), '') is not null
    or nullif(current_setting('helix.actor_id', true), '') is not null
  then
    raise insufficient_privilege using
      message = 'Meet recording recovery requires an unscoped worker context';
  end if;
  return query
    select upload.id, upload.org_id, upload.room_id, upload.storage_key, upload.mime_type,
      upload.egress_id, upload.created_at, upload.expires_at, upload.promoting_until
    from public.meet_recording_uploads upload
    where upload.source = 'egress'
      and upload.status = 'prepared'
      and upload.completed_at is null
    order by upload.created_at, upload.id
    limit batch_limit;
end
$$;

revoke all on function helix_list_pending_meet_egress_recordings(integer)
  from public, helix_readonly;
grant execute on function helix_list_pending_meet_egress_recordings(integer)
  to helix_app, helix_worker;
