-- postgres.js already serializes JSONB parameters; older writes encoded twice.
update pending_actions set requester_principal=(requester_principal #>> '{}')::jsonb
 where jsonb_typeof(requester_principal)='string';
update pending_actions set preview=(preview #>> '{}')::jsonb
 where jsonb_typeof(preview)='string';
