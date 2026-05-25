create table if not exists drive_comments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  object_id uuid not null references objects(id) on delete cascade,
  parent_comment_id uuid references drive_comments(id) on delete cascade,
  actor_id uuid references actors(id) on delete set null,
  anchor jsonb not null default '{}'::jsonb,
  body text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  metadata jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create index if not exists drive_comments_object_status_created_idx
  on drive_comments (org_id, object_id, status, created_at);

create index if not exists drive_comments_parent_created_idx
  on drive_comments (parent_comment_id, created_at)
  where parent_comment_id is not null;
