create extension if not exists pgcrypto;

alter table drive_share_links
  add column if not exists token_hash bytea,
  add column if not exists password_hash text,
  add column if not exists max_downloads integer,
  add column if not exists download_count integer not null default 0,
  add column if not exists rate_limit_per_hour integer not null default 120,
  add column if not exists rate_window_started_at timestamptz not null default now(),
  add column if not exists rate_window_count integer not null default 0,
  add column if not exists last_used_at timestamptz;

update drive_share_links
set token_hash = digest(token, 'sha256')
where token_hash is null and token is not null;

alter table drive_share_links alter column token drop not null;
alter table drive_share_links alter column token_hash set not null;
alter table drive_share_links
  add constraint drive_share_links_max_downloads_check
    check (max_downloads is null or max_downloads > 0),
  add constraint drive_share_links_download_count_check check (download_count >= 0),
  add constraint drive_share_links_rate_limit_check check (rate_limit_per_hour between 1 and 10000),
  add constraint drive_share_links_rate_count_check check (rate_window_count >= 0);

create unique index if not exists drive_share_links_token_hash_idx
  on drive_share_links (token_hash);

-- Raw bearer tokens are intentionally destroyed after their digest is populated.
update drive_share_links set token = null where token is not null;
drop index if exists drive_share_links_token_key;

alter table objects
  add column if not exists drive_legal_hold boolean not null default false,
  add column if not exists trash_expires_at timestamptz;

create table if not exists drive_lifecycle_policies (
  org_id uuid primary key references orgs(id) on delete cascade,
  trash_retention_days integer not null default 30
    check (trash_retention_days between 1 and 3650),
  orphan_grace_hours integer not null default 24
    check (orphan_grace_hours between 1 and 720),
  updated_by_actor_id uuid references actors(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table drive_lifecycle_policies enable row level security;
drop policy if exists helix_tenant_isolation on drive_lifecycle_policies;
create policy helix_tenant_isolation on drive_lifecycle_policies
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

create index if not exists objects_drive_trash_expiry_idx
  on objects (org_id, trash_expires_at)
  where upload_state = 'trashed' and deleted_at is not null;
