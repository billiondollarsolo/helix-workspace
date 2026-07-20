-- Content-addressed Drive blobs with per-org refcounts (optional dedup path).
create table if not exists drive_blobs (
  org_id uuid not null,
  sha256 text not null,
  storage_key text not null,
  byte_size bigint not null,
  refcount integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, sha256)
);

create index if not exists drive_blobs_storage_key_idx on drive_blobs (storage_key);
