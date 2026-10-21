-- Meet recordings made by LiveKit Egress. Helix starts the recording itself, so
-- the upload record exists before the file does: its size and digest are filled
-- in when the recording ends, before validation and promotion.
alter table meet_recording_uploads
  alter column byte_size drop not null,
  alter column sha256 drop not null,
  add column source text not null default 'upload',
  add column egress_id text,
  add constraint meet_recording_uploads_source_check check (source in ('upload', 'egress')),
  add constraint meet_recording_uploads_digest_check
    check (status = 'prepared' or (byte_size is not null and sha256 is not null)),
  add constraint meet_recording_uploads_upload_digest_check
    check (source = 'egress' or (byte_size is not null and sha256 is not null));

create unique index meet_recording_uploads_egress_id_key
  on meet_recording_uploads (org_id, egress_id)
  where egress_id is not null;

-- At most one running Egress recording per room.
create unique index meet_recording_uploads_active_egress_key
  on meet_recording_uploads (org_id, room_id)
  where source = 'egress' and completed_at is null and status = 'prepared';
