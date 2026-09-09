-- Dispatch-time provider decisions and normalized managed-provider feedback.
-- Raw webhook bodies and secret values are intentionally not persisted.

alter table mail_outbound_providers
  add column if not exists webhook_secret_ref text;

alter table mail_outbound_messages
  add column if not exists provider_id text,
  add column if not exists provider_kind text,
  add column if not exists provider_decision_source text,
  add column if not exists provider_decided_at timestamptz,
  add column if not exists delivery_status text,
  add column if not exists delivery_event_at timestamptz;

do $$ begin
  alter table mail_outbound_messages
    add constraint mail_outbound_provider_decision_source_check
    check (
      provider_decision_source is null
      or provider_decision_source in ('sending_domain', 'org_default', 'environment')
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table mail_outbound_messages
    add constraint mail_outbound_delivery_status_check
    check (
      delivery_status is null
      or delivery_status in (
        'delivered', 'delayed', 'soft_bounce', 'hard_bounce', 'complaint', 'rejected'
      )
    );
exception when duplicate_object then null; end $$;

create index if not exists mail_outbound_provider_binding_idx
  on mail_outbound_messages (org_id, provider_id, provider_message_id)
  where provider_id is not null and provider_message_id is not null;

create table if not exists mail_provider_delivery_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  provider_id uuid not null references mail_outbound_providers(id) on delete restrict,
  outbound_id uuid references mail_outbound_messages(id) on delete set null,
  provider_event_id text not null,
  provider_message_id text not null,
  normalized_recipient text not null,
  event_type text not null check (
    event_type in (
      'delivered', 'delayed', 'soft_bounce', 'hard_bounce', 'complaint', 'rejected'
    )
  ),
  occurred_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint mail_provider_event_recipient_normalized check (
    normalized_recipient = lower(normalized_recipient)
    and normalized_recipient = btrim(normalized_recipient)
  )
);

create unique index if not exists mail_provider_delivery_events_idempotency_idx
  on mail_provider_delivery_events (org_id, provider_id, provider_event_id);
create index if not exists mail_provider_delivery_events_outbound_idx
  on mail_provider_delivery_events (org_id, outbound_id, occurred_at, id);
create index if not exists mail_provider_delivery_events_threshold_idx
  on mail_provider_delivery_events (org_id, event_type, occurred_at desc);

create table if not exists mail_suppressions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  normalized_recipient text not null,
  reason text not null check (reason in ('hard_bounce', 'complaint')),
  source_event_id uuid not null references mail_provider_delivery_events(id) on delete restrict,
  cleared_at timestamptz,
  cleared_by uuid references actors(id),
  clear_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mail_suppression_recipient_normalized check (
    normalized_recipient = lower(normalized_recipient)
    and normalized_recipient = btrim(normalized_recipient)
  ),
  constraint mail_suppression_clear_complete check (
    (cleared_at is null and cleared_by is null and clear_reason is null)
    or (cleared_at is not null and cleared_by is not null and char_length(clear_reason) >= 3)
  )
);

create unique index if not exists mail_suppressions_org_recipient_active_idx
  on mail_suppressions (org_id, normalized_recipient)
  where cleared_at is null;
create index if not exists mail_suppressions_org_created_idx
  on mail_suppressions (org_id, created_at desc);

create or replace function mail_provider_event_validate_tenant()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from mail_outbound_providers
    where id = new.provider_id and org_id = new.org_id
  ) then
    raise exception 'delivery event provider must belong to the event organization'
      using errcode = '23514',
            constraint = 'mail_provider_event_same_org';
  end if;
  if new.outbound_id is not null and not exists (
    select 1 from mail_outbound_messages
    where id = new.outbound_id
      and org_id = new.org_id
      and provider_id = new.provider_id::text
  ) then
    raise exception 'delivery event outbound message must match organization and provider'
      using errcode = '23514',
            constraint = 'mail_provider_event_outbound_same_org';
  end if;
  return new;
end
$$;

drop trigger if exists mail_provider_event_same_org on mail_provider_delivery_events;
create trigger mail_provider_event_same_org
before insert or update of org_id, provider_id, outbound_id
on mail_provider_delivery_events
for each row execute function mail_provider_event_validate_tenant();

create or replace function mail_suppression_validate_tenant()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from mail_provider_delivery_events
    where id = new.source_event_id and org_id = new.org_id
  ) then
    raise exception 'suppression source event must belong to the suppression organization'
      using errcode = '23514',
            constraint = 'mail_suppression_event_same_org';
  end if;
  if new.cleared_by is not null and not exists (
    select 1 from actors where id = new.cleared_by and org_id = new.org_id
  ) then
    raise exception 'suppression clearing actor must belong to the suppression organization'
      using errcode = '23514',
            constraint = 'mail_suppression_actor_same_org';
  end if;
  return new;
end
$$;

drop trigger if exists mail_suppression_same_org on mail_suppressions;
create trigger mail_suppression_same_org
before insert or update of org_id, source_event_id, cleared_by
on mail_suppressions
for each row execute function mail_suppression_validate_tenant();

alter table mail_provider_delivery_events enable row level security;
drop policy if exists helix_tenant_isolation on mail_provider_delivery_events;
create policy helix_tenant_isolation on mail_provider_delivery_events
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

alter table mail_suppressions enable row level security;
drop policy if exists helix_tenant_isolation on mail_suppressions;
create policy helix_tenant_isolation on mail_suppressions
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
