-- 0025_meet_assistant_ui.sql — backend support for the new Meet and Assistant UI surfaces.
--
-- Meet: the Meet hub renders a "Today / Upcoming" panel that needs meetings that
-- have not started yet. The original meet_rooms model only tracked rooms that are
-- already 'active' or 'ended'. We add a third lifecycle state, 'scheduled', plus
-- the scheduling window so the hub can show start time + duration before a room
-- goes live, and a host attendee count is derived from permissions at query time.
--
-- Assistant: the Assistant UI thread list needs per-conversation pin state so a
-- user can keep important conversations at the top. assistant_conversations
-- gains a pinned_at column (null = not pinned); pin ordering is pinned_at desc.

-- --- Meet ----------------------------------------------------------------------

alter table meet_rooms
  add column if not exists scheduled_start_at timestamptz,
  add column if not exists scheduled_end_at timestamptz;

-- Widen the status check to include the new 'scheduled' lifecycle state.
alter table meet_rooms
  drop constraint if exists meet_rooms_status_check;
alter table meet_rooms
  add constraint meet_rooms_status_check
  check (status in ('scheduled', 'active', 'ended'));

-- Scheduled meetings are queried by their start time for the "upcoming" panel.
create index if not exists meet_rooms_org_scheduled_start_idx
  on meet_rooms (org_id, scheduled_start_at)
  where status = 'scheduled';

-- --- Assistant -----------------------------------------------------------------

alter table assistant_conversations
  add column if not exists pinned_at timestamptz;

-- The thread list orders pinned conversations first, each group by recency.
create index if not exists assistant_conversations_actor_pinned_updated_idx
  on assistant_conversations (actor_id, pinned_at desc nulls last, updated_at desc);
