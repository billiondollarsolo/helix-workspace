-- Roll back 0088_activity_hash_shape.
--
-- Only drops the shape constraints. No data was changed by 0088 — it was
-- added NOT VALID precisely so existing rows were left alone — so there is
-- nothing to restore.

alter table activity drop constraint if exists activity_this_hash_sha256;
alter table activity drop constraint if exists activity_prev_hash_sha256;
