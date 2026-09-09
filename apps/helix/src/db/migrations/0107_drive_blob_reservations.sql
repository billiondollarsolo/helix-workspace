create table if not exists drive_blob_reservations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  object_id uuid not null references objects(id) on delete cascade,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists drive_blob_reservations_org_storage_idx
  on drive_blob_reservations (org_id, storage_key, expires_at);
create unique index if not exists drive_blob_reservations_object_idx
  on drive_blob_reservations (org_id, object_id);

alter table drive_blob_reservations enable row level security;
alter table drive_blob_reservations force row level security;
drop policy if exists helix_tenant_isolation on drive_blob_reservations;
create policy helix_tenant_isolation on drive_blob_reservations
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
