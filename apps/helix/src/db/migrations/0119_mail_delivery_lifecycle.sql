-- Provider acceptance is not final delivery. Persist authenticated feedback and
-- suppress recipients after permanent failures.
drop index if exists mail_outbound_due_idx;
drop index if exists mail_outbound_stale_lease_idx;
alter table mail_outbound_messages drop constraint if exists mail_outbound_lease_state_check;

alter type mail_outbound_status rename to mail_outbound_status_old;
create type mail_outbound_status as enum (
  'queued', 'cancelled', 'sending', 'accepted', 'delivered',
  'deferred', 'bounced', 'complained', 'failed'
);
alter table mail_outbound_messages alter column status drop default;
alter table mail_outbound_messages
  alter column status type mail_outbound_status
  using (
    case when status::text = 'sent' then 'accepted' else status::text end
  )::mail_outbound_status;
alter table mail_outbound_messages alter column status set default 'queued';
drop type mail_outbound_status_old;

create index mail_outbound_due_idx on mail_outbound_messages (next_attempt_at, id)
  where status = 'queued' and dead_lettered_at is null;
create index mail_outbound_stale_lease_idx on mail_outbound_messages (lease_expires_at, id)
  where status = 'sending';
alter table mail_outbound_messages add constraint mail_outbound_lease_state_check check (
  (status = 'sending' and next_attempt_at is null and lease_owner is not null
    and lease_token is not null and lease_expires_at is not null)
  or (status = 'queued' and next_attempt_at is not null and lease_owner is null
    and lease_token is null and lease_expires_at is null)
  or (status not in ('sending', 'queued') and lease_owner is null
    and lease_token is null and lease_expires_at is null)
);

alter table mail_outbound_providers
  add column if not exists webhook_secret_ref text;
-- Main's provider callbacks used global environment indirections. They must be
-- reprovisioned as tenant Vault handles, never interpreted as another tenant's secret.
update mail_outbound_providers set webhook_secret_ref = null, enabled = false
where webhook_secret_ref is not null
  and webhook_secret_ref !~ '^[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?$';
alter table mail_outbound_providers
  add constraint mail_outbound_provider_webhook_secret_ref_check check (
    webhook_secret_ref is null
    or webhook_secret_ref ~ '^[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?$'
  );

create type mail_delivery_event_kind as enum (
  'accepted', 'delivered', 'deferred', 'bounced', 'complained'
);
create type mail_delivery_event_source as enum ('provider', 'dsn');
create type mail_delivery_retry_class as enum ('none', 'transient', 'permanent');
create type mail_suppression_reason as enum ('hard_bounce', 'complaint', 'manual');

create unique index if not exists mail_outbound_org_id_uidx
  on mail_outbound_messages (org_id, id);
create unique index if not exists mail_provider_org_id_uidx
  on mail_outbound_providers (org_id, id);

create table mail_delivery_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  provider_id uuid not null,
  outbound_id uuid not null,
  provider_event_id text not null,
  source mail_delivery_event_source not null,
  kind mail_delivery_event_kind not null,
  retry_class mail_delivery_retry_class not null,
  recipient text not null,
  diagnostic text,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint mail_delivery_events_provider_fk foreign key (org_id, provider_id)
    references mail_outbound_providers (org_id, id) on delete restrict,
  constraint mail_delivery_events_outbound_fk foreign key (org_id, outbound_id)
    references mail_outbound_messages (org_id, id) on delete cascade,
  constraint mail_delivery_events_recipient_check check (
    recipient = lower(btrim(recipient)) and length(recipient) between 3 and 320
  ),
  constraint mail_delivery_events_retry_class_check check (
    (kind in ('accepted', 'delivered') and retry_class = 'none')
    or (kind = 'deferred' and retry_class = 'transient')
    or (kind in ('bounced', 'complained') and retry_class = 'permanent')
  ),
  unique (org_id, provider_id, provider_event_id),
  unique (org_id, id)
);

create index mail_delivery_events_outbound_idx
  on mail_delivery_events (org_id, outbound_id, occurred_at desc);

create table mail_suppressions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  address text not null,
  reason mail_suppression_reason not null,
  source_event_id uuid,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid,
  remove_reason text,
  constraint mail_suppressions_event_fk foreign key (org_id, source_event_id)
    references mail_delivery_events (org_id, id) on delete restrict,
  constraint mail_suppressions_removed_by_fk foreign key (org_id, removed_by)
    references actors (org_id, id) on delete restrict,
  constraint mail_suppressions_address_check check (
    address = lower(btrim(address)) and length(address) between 3 and 320
  ),
  constraint mail_suppressions_removal_check check (
    (removed_at is null and removed_by is null and remove_reason is null)
    or (removed_at is not null and removed_by is not null and length(btrim(remove_reason)) > 0)
  )
);

create unique index mail_suppressions_active_address_uidx
  on mail_suppressions (org_id, address) where removed_at is null;
create index mail_suppressions_org_created_idx
  on mail_suppressions (org_id, created_at desc);

alter table mail_delivery_events enable row level security;
alter table mail_suppressions enable row level security;
alter table mail_delivery_events force row level security;
alter table mail_suppressions force row level security;
create policy helix_tenant_isolation on mail_delivery_events
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());
create policy helix_tenant_isolation on mail_suppressions
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());

revoke all on mail_delivery_events, mail_suppressions from public, helix_readonly;
grant select, insert, update, delete on mail_delivery_events, mail_suppressions
  to helix_app, helix_worker;
