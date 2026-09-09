-- SMTP and media webhooks are unauthenticated gateways that must discover a
-- tenant before ordinary tenant RLS context exists. Keep those narrow lookups
-- in fixed, parameterized definer functions instead of giving the app role a
-- general RLS-bypass connection.

drop function if exists helix_resolve_inbound_mailbox(text, text);

create function helix_resolve_inbound_mailbox(
  requested_address text,
  requested_domain text
)
returns table (org_id uuid, actor_id uuid, address text, quota_exceeded boolean)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with verified_domains as (
    select
      d.org_id,
      case
        when o.quotas ? 'storage_bytes_limit'
          then nullif(o.quotas ->> 'storage_bytes_limit', '')::bigint
        when p.quotas_default ? 'storage_bytes_limit'
          then nullif(p.quotas_default ->> 'storage_bytes_limit', '')::bigint
        else 5000000000::bigint
      end as storage_bytes_limit
    from public.admin_domains d
    join public.orgs o on o.id = d.org_id
    left join public.plans p on p.id = o.plan_id
    where lower(d.domain) = requested_domain
      and d.verification_status = 'verified'
      and d.verified_at is not null
      and o.status = 'active'
      and o.suspended_at is null
      and o.soft_deleted_at is null
      and o.hard_deleted_at is null
  ), candidates as (
    select a.org_id, a.id as actor_id, a.email as address, d.storage_bytes_limit
    from verified_domains d
    join public.actors a on a.org_id = d.org_id
    where a.type = 'user'
      and a.disabled_at is null
      and lower(a.email) = requested_address
    union
    select alias.org_id, alias.actor_id, alias.email as address, d.storage_bytes_limit
    from verified_domains d
    join public.mail_aliases alias on alias.org_id = d.org_id
    join public.actors a on a.id = alias.actor_id and a.org_id = alias.org_id
    where alias.enabled = true
      and alias.disabled_at is null
      and a.type = 'user'
      and a.disabled_at is null
      and lower(alias.email) = requested_address
  )
  select distinct
    candidates.org_id,
    candidates.actor_id,
    candidates.address,
    coalesce(
      (
        select coalesce(sum(stored_object.byte_size), 0)::bigint
        from (
          -- ponytail: scan current storage until DRV-29 supplies an atomic usage counter.
          select distinct on (stored.storage_key) stored.storage_key, stored.byte_size
          from (
            select object.storage_key, object.byte_size, 0 as source_rank
            from public.objects object
            where object.org_id = candidates.org_id
              and object.kind in ('file', 'recording', 'mail_attachment')
              and object.deleted_at is null
              and coalesce(object.metadata->>'status', 'ready') = 'ready'
            union all
            select version.storage_key, version.byte_size, 1 as source_rank
            from public.drive_versions version
            join public.objects object
              on object.id = version.object_id and object.org_id = version.org_id
            where version.org_id = candidates.org_id
              and object.kind in ('file', 'recording')
              and object.deleted_at is null
              and coalesce(object.metadata->>'status', 'ready') = 'ready'
          ) stored
          order by stored.storage_key, stored.source_rank
        ) stored_object
      ) >= candidates.storage_bytes_limit,
      false
    ) as quota_exceeded
  from candidates
  limit 2
$$;

create or replace function helix_prepare_meet_recording_upload(
  upload_id uuid,
  tenant_id uuid,
  meet_room_id uuid,
  object_key text,
  media_type text,
  media_bytes integer,
  media_sha256 text,
  upload_expires_at timestamptz
)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  with inserted as (
    insert into public.meet_recording_uploads (
      id, org_id, room_id, storage_key, mime_type, byte_size, sha256, expires_at
    )
    select
      upload_id, tenant_id, room.id, object_key, media_type,
      media_bytes, media_sha256, upload_expires_at
    from public.meet_rooms room
    where room.id = meet_room_id and room.org_id = tenant_id
    on conflict do nothing
    returning id
  )
  select exists(select 1 from inserted)
$$;

create or replace function helix_get_meet_recording_upload(upload_id uuid)
returns table (
  id uuid,
  org_id uuid,
  room_id uuid,
  room_name text,
  storage_key text,
  mime_type text,
  byte_size integer,
  sha256 text,
  expires_at timestamptz,
  completed_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    upload.id, upload.org_id, upload.room_id, room.room_name,
    upload.storage_key, upload.mime_type, upload.byte_size, upload.sha256,
    upload.expires_at, upload.completed_at
  from public.meet_recording_uploads upload
  join public.meet_rooms room
    on room.id = upload.room_id and room.org_id = upload.org_id
  where upload.id = upload_id
  limit 1
$$;

create or replace function helix_complete_meet_recording_upload(upload_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  with completed as (
    update public.meet_recording_uploads
    set completed_at = now()
    where id = upload_id
      and completed_at is null
      and expires_at > now()
    returning id
  )
  select exists(select 1 from completed)
$$;

comment on function helix_resolve_inbound_mailbox(text, text) is
  'Exact verified mailbox routing for the pre-tenant SMTP gateway.';
comment on function helix_prepare_meet_recording_upload(uuid, uuid, uuid, text, text, integer, text, timestamptz) is
  'Creates a tenant-bound, random recording-upload capability.';
comment on function helix_get_meet_recording_upload(uuid) is
  'Resolves one random recording-upload capability for the authenticated media webhook.';
comment on function helix_complete_meet_recording_upload(uuid) is
  'Atomically consumes one unexpired recording-upload capability.';
