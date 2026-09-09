create table drive_webdav_locks (
  org_id uuid not null references orgs(id) on delete cascade,
  path_key text not null check (path_key like '/%' and length(path_key) <= 4096),
  token uuid not null unique,
  actor_id uuid not null,
  owner text not null default '' check (length(owner) <= 1024),
  depth text not null check (depth in ('0', 'infinity')),
  fence bigint generated always as identity unique,
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null,
  primary key (org_id, path_key),
  foreign key (org_id, actor_id) references actors(org_id, id) on delete cascade,
  check (expires_at > created_at)
);

create index drive_webdav_locks_expiry_idx
  on drive_webdav_locks (expires_at);

alter table drive_webdav_locks enable row level security;
alter table drive_webdav_locks force row level security;

create policy drive_webdav_locks_tenant_read on drive_webdav_locks for select
  using (org_id = helix_current_org_id());
create policy drive_webdav_locks_actor_insert on drive_webdav_locks for insert
  with check (org_id = helix_current_org_id() and actor_id = helix_current_actor_id());
create policy drive_webdav_locks_actor_update on drive_webdav_locks for update
  using (org_id = helix_current_org_id() and actor_id = helix_current_actor_id())
  with check (org_id = helix_current_org_id() and actor_id = helix_current_actor_id());
create policy drive_webdav_locks_actor_delete on drive_webdav_locks for delete
  using (org_id = helix_current_org_id() and actor_id = helix_current_actor_id());

alter table drive_webdav_locks owner to helix_migration_owner;
alter sequence drive_webdav_locks_fence_seq owner to helix_migration_owner;
revoke all on drive_webdav_locks from public;
revoke all on sequence drive_webdav_locks_fence_seq from public;
grant select, insert, update, delete on drive_webdav_locks to helix_app;
grant usage, select on sequence drive_webdav_locks_fence_seq to helix_app;
