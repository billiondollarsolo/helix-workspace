create table if not exists drive_folders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  name text not null,
  parent_folder_id uuid references drive_folders(id),
  owner_actor_id uuid references actors(id),
  created_by_actor_id uuid references actors(id),
  metadata jsonb not null default '{}',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists drive_folders_org_parent_idx on drive_folders (org_id, parent_folder_id);
create index if not exists drive_folders_owner_idx on drive_folders (owner_actor_id);

create table if not exists drive_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  object_id uuid not null references objects(id) on delete cascade,
  version_number integer not null,
  storage_key text not null,
  mime_type text not null,
  byte_size integer not null,
  sha256 text not null,
  metadata jsonb not null default '{}',
  created_by_actor_id uuid references actors(id),
  created_at timestamptz not null default now()
);

create unique index if not exists drive_versions_object_version_idx on drive_versions (object_id, version_number);
create index if not exists drive_versions_object_created_idx on drive_versions (object_id, created_at);
create index if not exists drive_versions_org_object_idx on drive_versions (org_id, object_id);
