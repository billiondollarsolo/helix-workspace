drop function if exists helix_list_pending_meet_egress_recordings(integer);
alter table meet_recording_uploads drop column if exists promoting_until;
