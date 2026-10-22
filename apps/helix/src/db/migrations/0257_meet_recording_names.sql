-- Name saved Meet recordings after their meeting and start time, so Drive's
-- Recordings view lists them legibly. New recordings are named when saved.
update objects o
set metadata = o.metadata || jsonb_build_object(
    'name',
    coalesce(nullif(btrim(r.subject), ''), 'Meeting') || ' ('
      || to_char(
        coalesce((o.metadata->>'startedAt')::timestamptz, o.created_at) at time zone 'UTC',
        'YYYY-MM-DD HH24:MI'
      )
      || ' UTC).mp4'
  ),
  updated_at = now()
from meet_rooms r
where o.kind = 'recording'
  and o.metadata->>'name' is null
  and r.org_id = o.org_id
  and r.id::text = o.metadata->>'roomId';
