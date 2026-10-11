-- S3-compatible Drive gateway.
--
-- drive_s3_access_keys holds user-created S3 access keys. SigV4 verification
-- needs the secret itself, so it is stored as a tenant envelope (AES-256-GCM,
-- per-tenant KEK) rather than a one-way hash, and it is shown only on creation.
-- Keys authenticate as their actor, restricted to the key's Drive scopes and
-- to the actor's current authority; a disabled or offboarded actor's keys stop
-- working through helix_credential_principal_is_active.
--
-- drive_s3_multipart_uploads/parts track gateway multipart uploads. Parts are
-- staged in the tenant's object store under a private gateway prefix; the
-- assembled object is written through the normal Drive upload pipeline
-- (malware scan, DLP, quota, versions, audit) on CompleteMultipartUpload.
create table if not exists drive_s3_access_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  actor_id uuid not null,
  access_key_id text not null unique check (access_key_id ~ '^HLX[A-Z2-7]{17}$'),
  secret_envelope text not null,
  label text not null check (char_length(label) between 1 and 120),
  scopes text[] not null check (cardinality(scopes) between 1 and 3),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (org_id, actor_id) references actors (org_id, id) on delete cascade
);

create index if not exists drive_s3_access_keys_actor_idx
  on drive_s3_access_keys (org_id, actor_id, created_at desc);

create table if not exists drive_s3_multipart_uploads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  actor_id uuid not null,
  access_key_id text not null,
  bucket text not null,
  object_key text not null check (char_length(object_key) between 1 and 1024),
  content_type text not null,
  user_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (org_id, id),
  foreign key (org_id, actor_id) references actors (org_id, id) on delete cascade
);

create index if not exists drive_s3_multipart_uploads_actor_idx
  on drive_s3_multipart_uploads (org_id, actor_id, bucket, object_key);

create index if not exists drive_s3_multipart_uploads_expiry_idx
  on drive_s3_multipart_uploads (org_id, expires_at);

create table if not exists drive_s3_multipart_parts (
  org_id uuid not null references orgs(id) on delete cascade,
  upload_id uuid not null,
  part_number integer not null check (part_number between 1 and 10000),
  storage_key text not null,
  byte_size bigint not null check (byte_size >= 0),
  md5 text not null check (md5 ~ '^[0-9a-f]{32}$'),
  created_at timestamptz not null default now(),
  primary key (upload_id, part_number),
  foreign key (org_id, upload_id) references drive_s3_multipart_uploads (org_id, id)
    on delete cascade
);

do $migration$
declare
  tenant_table text;
begin
  foreach tenant_table in array array[
    'drive_s3_access_keys',
    'drive_s3_multipart_uploads',
    'drive_s3_multipart_parts'
  ]
  loop
    execute format('alter table public.%I enable row level security', tenant_table);
    execute format('alter table public.%I force row level security', tenant_table);
    execute format('drop policy if exists helix_tenant_isolation on public.%I', tenant_table);
    execute format(
      'create policy helix_tenant_isolation on public.%I
       using (org_id = helix_current_org_id())
       with check (org_id = helix_current_org_id())',
      tenant_table
    );
    execute format('drop policy if exists helix_tenant_boundary on public.%I', tenant_table);
    execute format(
      'create policy helix_tenant_boundary on public.%I as restrictive for all
       using (org_id = public.helix_current_org_id())
       with check (org_id = public.helix_current_org_id())',
      tenant_table
    );
  end loop;
end
$migration$;
