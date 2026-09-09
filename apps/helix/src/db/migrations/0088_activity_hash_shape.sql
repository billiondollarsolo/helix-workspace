-- Require `activity.this_hash` to actually be a hash.
--
-- Sheets, Slides, Docs and Calendar each built their chain link by
-- concatenating the previous value instead of hashing it, so the column grew
-- by one segment per row:
--
--   root:sheets.sheet.created:<uuid>:<ts>:slides.deck.created:<uuid>:<ts>:…
--
-- `activity_hash_idx` is a unique btree over the column, so once a value
-- passed ~2704 bytes Postgres refused the insert:
--
--   index row size 2712 exceeds btree version 4 maximum 2704
--
-- and every operation that records activity — creating a sheet, deck,
-- document or event — failed with it. The application fix is in place; this
-- makes the shape an invariant of the table so a future writer cannot
-- reintroduce it. Eight call sites insert into this column, and only some of
-- them route through the shared helper.
--
-- NOT VALID is deliberate. Rows written before the fix hold the long strings,
-- and they are audit history: deleting or rewriting them to satisfy a
-- constraint would destroy the record this table exists to keep, and rewriting
-- a hash chain is exactly the tampering it is meant to make detectable. NOT
-- VALID enforces the rule on every INSERT and UPDATE from now on while leaving
-- the existing rows readable and untouched.
--
-- Deployments wanting a fully valid constraint can, after auditing the legacy
-- rows, run:
--
--   alter table activity validate constraint activity_this_hash_sha256;
--
-- which will fail while any malformed row remains, by design.

alter table activity
  drop constraint if exists activity_this_hash_sha256;

alter table activity
  add constraint activity_this_hash_sha256
  check (this_hash ~ '^[a-f0-9]{64}$')
  not valid;

-- prev_hash is nullable (the first row in an organization has no predecessor)
-- and holds the same digests, so it gets the same shape rule.
alter table activity
  drop constraint if exists activity_prev_hash_sha256;

alter table activity
  add constraint activity_prev_hash_sha256
  check (prev_hash is null or prev_hash ~ '^[a-f0-9]{64}$')
  not valid;
