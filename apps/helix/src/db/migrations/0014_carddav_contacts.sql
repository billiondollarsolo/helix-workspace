create sequence if not exists carddav_contacts_sync_version_seq;

create table if not exists carddav_contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  owner_actor_id uuid not null references actors(id) on delete cascade,
  href text not null,
  uid text not null,
  display_name text,
  email text,
  vcard text not null,
  etag text not null,
  sync_version bigint not null default nextval('carddav_contacts_sync_version_seq'),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists carddav_contacts_owner_href_active_idx
  on carddav_contacts (owner_actor_id, href)
  where deleted_at is null;

create index if not exists carddav_contacts_owner_active_idx
  on carddav_contacts (owner_actor_id, deleted_at, updated_at);

create index if not exists carddav_contacts_owner_sync_version_idx
  on carddav_contacts (owner_actor_id, sync_version);

create index if not exists carddav_contacts_org_email_idx
  on carddav_contacts (org_id, lower(email))
  where deleted_at is null and email is not null;
