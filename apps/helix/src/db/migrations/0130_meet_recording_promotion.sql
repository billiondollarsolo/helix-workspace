alter table meet_recording_uploads
  add column status text not null default 'prepared',
  add column validated_at timestamptz,
  add column validation jsonb not null default '{}'::jsonb,
  add constraint meet_recording_uploads_status_check
    check (status in ('prepared', 'ready', 'completed')),
  add constraint meet_recording_uploads_validation_check
    check ((status = 'prepared') = (validated_at is null));

update meet_recording_uploads
set status = 'completed', validated_at = completed_at, validation = '{"legacy":true}'::jsonb
where completed_at is not null;

create function helix_mark_meet_recording_ready(upload_id uuid, validation_evidence jsonb)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  with marked as (
    update public.meet_recording_uploads
    set status = 'ready', validated_at = now(), validation = validation_evidence
    where id = upload_id and status = 'prepared' and completed_at is null and expires_at > now()
      and jsonb_typeof(validation_evidence) = 'object'
      and validation_evidence->>'status' = 'ready'
    returning id
  )
  select exists(select 1 from marked) or exists(
    select 1 from public.meet_recording_uploads
    where id = upload_id and status = 'ready' and completed_at is null and expires_at > now()
  )
$$;

create or replace function helix_complete_meet_recording_upload(upload_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  with completed as (
    update public.meet_recording_uploads
    set completed_at = now(), status = 'completed'
    where id = upload_id and status = 'ready' and completed_at is null and expires_at > now()
    returning id
  )
  select exists(select 1 from completed)
$$;

create function meet_recording_object_content_immutable()
returns trigger
language plpgsql
as $$
begin
  if old.kind = 'recording' and (
    new.org_id is distinct from old.org_id
    or new.storage_key is distinct from old.storage_key
    or new.mime_type is distinct from old.mime_type
    or new.byte_size is distinct from old.byte_size
    or new.sha256 is distinct from old.sha256
  ) then
    raise integrity_constraint_violation using message = 'validated Meet recording content is immutable';
  end if;
  return new;
end
$$;

create trigger objects_meet_recording_content_immutable
before update on objects
for each row execute function meet_recording_object_content_immutable();

revoke all on function helix_mark_meet_recording_ready(uuid, jsonb) from public, helix_readonly;
grant execute on function helix_mark_meet_recording_ready(uuid, jsonb) to helix_app, helix_worker;
