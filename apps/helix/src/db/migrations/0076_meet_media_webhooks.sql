create unique index if not exists meet_rooms_org_id_id_unique_idx
  on meet_rooms (org_id, id);

create table if not exists meet_recording_uploads (
  id uuid primary key,
  org_id uuid not null,
  room_id uuid not null,
  storage_key text not null,
  mime_type text not null,
  byte_size integer not null check (byte_size > 0),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, storage_key),
  constraint meet_recording_uploads_org_id_room_id_meet_rooms_fk
    foreign key (org_id, room_id) references meet_rooms(org_id, id) on delete cascade
);

create index if not exists meet_recording_uploads_expiry_idx
  on meet_recording_uploads (expires_at)
  where completed_at is null;

alter table meet_recording_uploads enable row level security;
drop policy if exists helix_tenant_isolation on meet_recording_uploads;
create policy helix_tenant_isolation on meet_recording_uploads
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

-- Global HMAC replay receipts contain no tenant content. A digest is inserted
-- once inside the bounded signature window and cannot be claimed again.
create table if not exists meet_media_webhook_receipts (
  id text primary key check (char_length(id) = 64),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists meet_media_webhook_receipts_expiry_idx
  on meet_media_webhook_receipts (expires_at);
