-- Meet media moved from Jitsi to LiveKit: the room's media host is no longer a Jitsi domain.
alter table meet_rooms rename column jitsi_domain to media_domain;
