create type mail_attachment_ingest_status as enum (
  'pending_upload', 'quarantined', 'scanning', 'clean', 'attached', 'rejected'
);

create table mail_attachment_ingestions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  owner_actor_id uuid,
  object_id uuid not null,
  message_id uuid,
  status mail_attachment_ingest_status not null default 'pending_upload',
  storage_key text not null,
  filename text,
  disposition text not null default 'attachment',
  declared_mime_type text not null,
  authoritative_mime_type text,
  expected_byte_size bigint not null,
  actual_byte_size bigint,
  expected_sha256 text not null,
  actual_sha256 text,
  scan_evidence jsonb not null default '{}'::jsonb,
  failure_reason text,
  expires_at timestamptz not null,
  attached_at timestamptz,
  rejected_at timestamptz,
  cleaned_at timestamptz,
  cleanup_attempt_count integer not null default 0,
  last_cleanup_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mail_attachment_ingestions_owner_fk foreign key (org_id, owner_actor_id)
    references actors(org_id, id) on delete restrict,
  constraint mail_attachment_ingestions_object_fk foreign key (org_id, object_id)
    references objects(org_id, id) on delete restrict,
  constraint mail_attachment_ingestions_message_fk foreign key (org_id, message_id)
    references messages(org_id, id) on delete restrict,
  constraint mail_attachment_ingestions_hash_check check (
    expected_sha256 ~ '^[a-f0-9]{64}$'
    and (actual_sha256 is null or actual_sha256 ~ '^[a-f0-9]{64}$')
  ),
  constraint mail_attachment_ingestions_size_check check (
    expected_byte_size >= 0 and (actual_byte_size is null or actual_byte_size >= 0)
    and cleanup_attempt_count >= 0
  ),
  constraint mail_attachment_ingestions_state_check check (
    (status = 'pending_upload' and actual_sha256 is null and message_id is null)
    or (status in ('quarantined', 'scanning') and actual_sha256 is not null and message_id is null)
    or (status = 'clean' and actual_sha256 is not null and message_id is null
      and scan_evidence->>'scanned' = 'true')
    or (status = 'attached' and message_id is not null and attached_at is not null
      and rejected_at is null and cleaned_at is null)
    or (status = 'rejected' and message_id is null and rejected_at is not null
      and length(btrim(failure_reason)) > 0)
  ),
  unique (org_id, id),
  unique (org_id, object_id),
  unique (org_id, storage_key)
);

create index mail_attachment_ingestions_cleanup_idx
  on mail_attachment_ingestions (expires_at, id)
  where status <> 'attached' and cleaned_at is null;

create or replace function helix_can_read_mail_object(
  object_org_id uuid,
  object_id uuid,
  object_kind text,
  owner_actor_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case object_kind
    when 'mail_attachment' then
      public.helix_mail_service_context(object_org_id)
      or (
        exists (
          select 1 from public.mail_attachment_ingestions stage
          where stage.org_id = object_org_id and stage.object_id = $2
            and stage.status in ('clean', 'attached') and stage.cleaned_at is null
        )
        and (
          owner_actor_id = public.helix_current_actor_id()
          or exists (
            select 1 from public.message_attachments attachment
            where attachment.org_id = object_org_id and attachment.object_id = $2
              and public.helix_can_read_message_attachment(
                attachment.org_id,
                attachment.message_id
              )
          )
        )
      )
    when 'mail_source' then exists (
      select 1 from public.mail_raw_sources source
      where source.org_id = object_org_id and source.object_id = $2
        and public.helix_can_read_mail_message(source.org_id, source.message_id)
    )
    else true
  end
$$;

create or replace function helix_attach_clean_mail_object()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  if exists (
    select 1 from public.objects object
    where object.org_id = new.org_id and object.id = new.object_id
      and object.kind = 'mail_attachment'
  ) then
    update public.mail_attachment_ingestions
    set status = 'attached', message_id = new.message_id, attached_at = now(),
      expires_at = 'infinity', updated_at = now()
    where org_id = new.org_id and object_id = new.object_id
      and status = 'clean' and message_id is null and cleaned_at is null;
    if not found then
      raise exception 'mail attachment is not clean and attachable';
    end if;
  end if;
  return new;
end
$$;

create trigger message_attachments_require_clean_stage
before insert on message_attachments
for each row execute function helix_attach_clean_mail_object();

create or replace function helix_claim_mail_attachment_cleanup(
  batch_limit integer,
  due_before timestamptz,
  claim_until timestamptz
)
returns table (
  id uuid,
  org_id uuid,
  owner_actor_id uuid,
  object_id uuid,
  storage_key text
)
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  if batch_limit not between 1 and 500 or claim_until <= due_before then
    raise exception 'invalid mail attachment cleanup claim';
  end if;
  if nullif(current_setting('helix.org_id', true), '') is not null
    or nullif(current_setting('helix.actor_id', true), '') is not null
  then
    raise insufficient_privilege using
      message = 'mail attachment cleanup requires an unscoped worker context';
  end if;
  return query
    with due as (
      select stage.id
      from public.mail_attachment_ingestions stage
      where stage.status <> 'attached' and stage.cleaned_at is null
        and stage.expires_at <= due_before
      order by stage.expires_at, stage.id
      limit batch_limit for update skip locked
    )
    update public.mail_attachment_ingestions stage set
      expires_at = claim_until,
      cleanup_attempt_count = stage.cleanup_attempt_count + 1,
      updated_at = now()
    from due where stage.id = due.id
    returning stage.id, stage.org_id, stage.owner_actor_id, stage.object_id, stage.storage_key;
end
$$;

alter table mail_attachment_ingestions enable row level security;
alter table mail_attachment_ingestions force row level security;
create policy helix_tenant_isolation on mail_attachment_ingestions
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());

revoke all on mail_attachment_ingestions from public, helix_readonly;
grant select, insert, update, delete on mail_attachment_ingestions to helix_app, helix_worker;
revoke all on function helix_claim_mail_attachment_cleanup(integer, timestamptz, timestamptz)
  from public, helix_readonly;
grant execute on function helix_claim_mail_attachment_cleanup(integer, timestamptz, timestamptz)
  to helix_app, helix_worker;
