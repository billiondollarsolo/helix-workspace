-- Per-slide revision counter for compare-and-swap on concurrent edits.
--
-- Before this column, two clients concurrently editing different shapes on the
-- same slide would each send the whole slide content; the second write
-- silently overwrote the first (last-write-wins). The interim safety net
-- compares the client's `expectedRevision` against the current value: on
-- mismatch the server rejects the operation with `slide-conflict` and the
-- client re-fetches before retrying. A future per-shape OT migration (see
-- docs/reviews/follow-up.md) will replace this CAS with a real merge.

alter table slides
  add column if not exists revision integer not null default 1;

-- Existing slide rows backfilled to revision 1 so first updates are accepted.
update slides set revision = 1 where revision is null;
