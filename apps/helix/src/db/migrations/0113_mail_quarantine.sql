create table mail_quarantines (
  id uuid primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  recipient_addresses text[] not null,
  envelope_from text,
  remote_address text,
  helo text,
  provider_delivery_id text,
  storage_key text not null unique,
  byte_size bigint not null check (byte_size between 1 and 52428800),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  signature text not null check (char_length(signature) between 1 and 512),
  authentication jsonb not null default '{}'::jsonb,
  scan_evidence jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'rechecking', 'released', 'deleted')),
  release_token uuid,
  release_lease_expires_at timestamptz,
  released_message_id uuid,
  resolved_by_actor_id uuid,
  resolution_reason text,
  resolved_at timestamptz,
  bytes_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint mail_quarantines_recipients_check check (
    cardinality(recipient_addresses) between 1 and 100
    and array_position(recipient_addresses, null) is null
  ),
  constraint mail_quarantines_reason_check check (
    resolution_reason is null or char_length(resolution_reason) between 1 and 500
  ),
  constraint mail_quarantines_resolution_check check (
    (status = 'pending'
      and release_token is null
      and release_lease_expires_at is null
      and released_message_id is null
      and resolved_by_actor_id is null
      and resolution_reason is null
      and resolved_at is null)
    or (status = 'rechecking'
      and release_token is not null
      and release_lease_expires_at is not null
      and released_message_id is null
      and resolved_by_actor_id is null
      and resolution_reason is null
      and resolved_at is null)
    or (status = 'released'
      and release_token is null
      and release_lease_expires_at is null
      and released_message_id is not null
      and resolved_by_actor_id is not null
      and resolution_reason is not null
      and resolved_at is not null)
    or (status = 'deleted'
      and release_token is null
      and release_lease_expires_at is null
      and released_message_id is null
      and resolved_by_actor_id is not null
      and resolution_reason is not null
      and resolved_at is not null)
  ),
  constraint mail_quarantines_released_message_fk
    foreign key (org_id, released_message_id) references messages(org_id, id) on delete restrict,
  constraint mail_quarantines_resolver_fk
    foreign key (org_id, resolved_by_actor_id) references actors(org_id, id) on delete restrict
);

create index mail_quarantines_org_pending_idx
  on mail_quarantines (org_id, created_at)
  where status = 'pending';

create or replace function helix_can_read_mail_quarantine(quarantine_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    quarantine_org_id = public.helix_current_org_id()
    and (
      public.helix_mail_service_context(quarantine_org_id)
      or exists (
        select 1
        from public.actors actor
        where actor.org_id = quarantine_org_id
          and actor.id = public.helix_current_actor_id()
          and actor.disabled_at is null
          and actor.scopes && array[
            'admin.console.read', 'admin.console.write', 'admin.*', 'mail.admin'
          ]::text[]
      )
    )
$$;

create or replace function helix_can_write_mail_quarantine(quarantine_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    quarantine_org_id = public.helix_current_org_id()
    and (
      public.helix_mail_service_context(quarantine_org_id)
      or exists (
        select 1
        from public.actors actor
        where actor.org_id = quarantine_org_id
          and actor.id = public.helix_current_actor_id()
          and actor.disabled_at is null
          and actor.scopes && array[
            'admin.console.write', 'admin.*', 'mail.admin'
          ]::text[]
      )
    )
$$;

alter table mail_quarantines enable row level security;
alter table mail_quarantines force row level security;
create policy helix_mail_quarantine_admin_only on mail_quarantines
  using (helix_can_read_mail_quarantine(org_id))
  with check (helix_can_write_mail_quarantine(org_id));

revoke all on mail_quarantines from public, helix_readonly;
grant select, insert, update, delete on mail_quarantines to helix_app, helix_worker;
