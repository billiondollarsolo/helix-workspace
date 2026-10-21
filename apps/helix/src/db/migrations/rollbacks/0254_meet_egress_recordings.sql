drop index if exists meet_recording_uploads_active_egress_key;
drop index if exists meet_recording_uploads_egress_id_key;
delete from meet_recording_uploads where source = 'egress' and (byte_size is null or sha256 is null);
alter table meet_recording_uploads
  drop constraint if exists meet_recording_uploads_upload_digest_check,
  drop constraint if exists meet_recording_uploads_digest_check,
  drop constraint if exists meet_recording_uploads_source_check,
  drop column if exists egress_id,
  drop column if exists source,
  alter column sha256 set not null,
  alter column byte_size set not null;
