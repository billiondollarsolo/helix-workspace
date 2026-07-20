-- Public/anonymous Drive share links (elite plan T4.4).
create table if not exists drive_share_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  token text not null unique,
  object_id uuid not null references objects(id) on delete cascade,
  role text not null default 'reader' check (role in ('reader', 'commenter', 'editor')),
  expires_at timestamptz,
  created_by_actor_id uuid references actors(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists drive_share_links_object_idx
  on drive_share_links (org_id, object_id)
  where revoked_at is null;
