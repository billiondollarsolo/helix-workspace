alter table objects alter column byte_size type bigint;
alter table drive_versions alter column byte_size type bigint;
alter table drive_multipart_sessions alter column byte_size type bigint;
alter table meet_recording_uploads alter column byte_size type bigint;

alter table objects drop constraint if exists objects_byte_size_nonnegative;
alter table objects add constraint objects_byte_size_nonnegative check (byte_size >= 0);
alter table drive_versions drop constraint if exists drive_versions_byte_size_nonnegative;
alter table drive_versions add constraint drive_versions_byte_size_nonnegative check (byte_size >= 0);
alter table drive_blobs drop constraint if exists drive_blobs_refcount_nonnegative;
alter table drive_blobs add constraint drive_blobs_refcount_nonnegative check (refcount >= 0);

alter table drive_versions add column if not exists idempotency_key text;
create unique index if not exists drive_versions_idempotency_idx
  on drive_versions (org_id, object_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists drive_versions_org_storage_idx
  on drive_versions (org_id, storage_key);

-- The immutable version rows are the sole source of truth: exactly one blob
-- reference per version, never an extra reference for the mutable object row.
with canonical as (
  select org_id, lower(sha256) as sha256, min(storage_key) as storage_key
  from drive_versions
  where storage_key ~ '^drive/[^/]+/blobs/[0-9a-f]{64}(\.[0-9a-f-]{36})?$'
  group by org_id, lower(sha256)
), losing_keys as (
  select version.org_id, min(version.object_id::text)::uuid as object_id, version.storage_key
  from drive_versions version
  join canonical
    on canonical.org_id = version.org_id and canonical.sha256 = lower(version.sha256)
  where version.storage_key <> canonical.storage_key
  group by version.org_id, version.storage_key
)
insert into drive_quarantine_deletions (org_id, object_id, actor_id, storage_key)
select org_id, object_id, null, storage_key from losing_keys
on conflict (org_id, storage_key) do update
  set status = 'pending', next_attempt_at = now(), lease_expires_at = null, updated_at = now();

with canonical as (
  select org_id, lower(sha256) as sha256, min(storage_key) as storage_key
  from drive_versions
  where storage_key ~ '^drive/[^/]+/blobs/[0-9a-f]{64}(\.[0-9a-f-]{36})?$'
  group by org_id, lower(sha256)
)
update drive_versions version
set storage_key = canonical.storage_key
from canonical
where canonical.org_id = version.org_id
  and canonical.sha256 = lower(version.sha256)
  and version.storage_key <> canonical.storage_key;

with canonical as (
  select org_id, lower(sha256) as sha256, min(storage_key) as storage_key
  from drive_versions
  where storage_key ~ '^drive/[^/]+/blobs/[0-9a-f]{64}(\.[0-9a-f-]{36})?$'
  group by org_id, lower(sha256)
)
update objects object
set storage_key = canonical.storage_key
from canonical
where canonical.org_id = object.org_id
  and canonical.sha256 = lower(object.sha256)
  and object.storage_key ~ '^drive/[^/]+/blobs/[0-9a-f]{64}(\.[0-9a-f-]{36})?$'
  and object.storage_key <> canonical.storage_key;

delete from drive_blobs;
insert into drive_blobs (org_id, sha256, storage_key, byte_size, refcount)
select org_id, lower(sha256), storage_key, max(byte_size), count(*)::integer
from drive_versions
where storage_key ~ '^drive/[^/]+/blobs/[0-9a-f]{64}(\.[0-9a-f-]{36})?$'
group by org_id, lower(sha256), storage_key;

drop index if exists drive_blobs_storage_key_idx;
create unique index if not exists drive_blobs_org_storage_key_idx
  on drive_blobs (org_id, storage_key);
