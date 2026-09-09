create table calendar_invitation_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  event_id uuid not null,
  actor_id uuid not null,
  event_revision integer not null check (event_revision >= 0),
  recipient text not null check (
    recipient = lower(btrim(recipient)) and char_length(recipient) between 3 and 320
  ),
  message_type text not null check (message_type in ('REQUEST', 'CANCEL')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'handed_off', 'superseded', 'dead_lettered')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz,
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  mail_outbound_id uuid,
  last_error text,
  handed_off_at timestamptz,
  dead_lettered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, event_id, event_revision, recipient, message_type),
  unique (org_id, id),
  foreign key (org_id, event_id) references cal_events(org_id, id) on delete cascade,
  foreign key (org_id, actor_id) references actors(org_id, id),
  foreign key (org_id, mail_outbound_id) references mail_outbound_messages(org_id, id),
  constraint calendar_invitation_delivery_lease_state check (
    (status = 'queued' and next_attempt_at is not null and lease_owner is null
      and lease_token is null and lease_expires_at is null)
    or (status = 'processing' and next_attempt_at is null and lease_owner is not null
      and lease_token is not null and lease_expires_at is not null)
    or (status not in ('queued', 'processing') and next_attempt_at is null
      and lease_owner is null and lease_token is null and lease_expires_at is null)
  ),
  constraint calendar_invitation_delivery_terminal_state check (
    (status = 'handed_off' and mail_outbound_id is not null and handed_off_at is not null)
    or (status = 'dead_lettered' and dead_lettered_at is not null and last_error is not null)
    or status in ('queued', 'processing', 'superseded')
  )
);

create index calendar_invitation_deliveries_due_idx
  on calendar_invitation_deliveries (coalesce(next_attempt_at, lease_expires_at), created_at, id)
  where status in ('queued', 'processing');

create unique index mail_outbound_calendar_message_id_uidx
  on mail_outbound_messages (org_id, (envelope ->> 'messageId'))
  where envelope ->> 'messageId' like '<calendar-delivery-%@helix.local>';

create table calendar_invitation_delivery_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  delivery_id uuid not null,
  status text not null,
  attempt_count integer not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (org_id, delivery_id)
    references calendar_invitation_deliveries(org_id, id) on delete cascade
);

create index calendar_invitation_delivery_events_idx
  on calendar_invitation_delivery_events (org_id, delivery_id, created_at, id);

create function helix_calendar_invitation_delivery_audit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status
    or new.attempt_count is distinct from old.attempt_count
  then
    insert into calendar_invitation_delivery_events (
      org_id, delivery_id, status, attempt_count, detail
    ) values (
      new.org_id,
      new.id,
      new.status,
      new.attempt_count,
      jsonb_strip_nulls(jsonb_build_object(
        'eventId', new.event_id,
        'eventRevision', new.event_revision,
        'recipient', new.recipient,
        'messageType', new.message_type,
        'mailOutboundId', new.mail_outbound_id,
        'lastError', new.last_error
      ))
    );
    insert into outbox (subject, payload)
    values (
      'activity.calendar.invitation.' || new.status,
      jsonb_build_object(
        'version', 1,
        'orgId', new.org_id,
        'actorId', new.actor_id,
        'eventId', new.event_id,
        'eventRevision', new.event_revision,
        'recipient', new.recipient,
        'messageType', new.message_type,
        'deliveryId', new.id,
        'attemptCount', new.attempt_count
      )
    );
  end if;
  return new;
end
$$;

create trigger calendar_invitation_deliveries_audit
after insert or update on calendar_invitation_deliveries
for each row execute function helix_calendar_invitation_delivery_audit();

create function helix_claim_calendar_invitation_deliveries(
  input_owner text,
  input_limit integer,
  input_lease_seconds integer
)
returns setof calendar_invitation_deliveries
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  with due as (
    select id
    from calendar_invitation_deliveries
    where (status = 'queued' and next_attempt_at <= statement_timestamp())
      or (status = 'processing' and lease_expires_at <= statement_timestamp())
    order by coalesce(next_attempt_at, lease_expires_at), created_at, id
    limit greatest(0, least(coalesce(input_limit, 0), 100))
    for update skip locked
  )
  update calendar_invitation_deliveries delivery
  set status = 'processing',
      attempt_count = attempt_count + 1,
      next_attempt_at = null,
      lease_owner = left(coalesce(input_owner, 'calendar-worker'), 200),
      lease_token = gen_random_uuid(),
      lease_expires_at = statement_timestamp()
        + make_interval(secs => greatest(1, least(coalesce(input_lease_seconds, 300), 3600))),
      updated_at = statement_timestamp()
  from due
  where delivery.id = due.id
  returning delivery.*
$$;

create function helix_complete_calendar_invitation_delivery(
  input_id uuid,
  input_lease_token uuid,
  input_mail_outbound_id uuid
)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  with completed as (
    update calendar_invitation_deliveries
    set status = 'handed_off',
        mail_outbound_id = input_mail_outbound_id,
        handed_off_at = statement_timestamp(),
        next_attempt_at = null,
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        last_error = null,
        updated_at = statement_timestamp()
    where id = input_id and status = 'processing' and lease_token = input_lease_token
    returning 1
  ) select exists(select 1 from completed)
$$;

create function helix_fail_calendar_invitation_delivery(
  input_id uuid,
  input_lease_token uuid,
  input_error text,
  input_retry_delay_seconds integer,
  input_max_attempts integer
)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  with failed as (
    update calendar_invitation_deliveries
    set status = case when attempt_count >= greatest(1, least(coalesce(input_max_attempts, 5), 100))
          then 'dead_lettered' else 'queued' end,
        next_attempt_at = case
          when attempt_count >= greatest(1, least(coalesce(input_max_attempts, 5), 100)) then null
          else statement_timestamp()
            + make_interval(secs => greatest(0, least(coalesce(input_retry_delay_seconds, 1), 86400))) end,
        dead_lettered_at = case
          when attempt_count >= greatest(1, least(coalesce(input_max_attempts, 5), 100))
          then statement_timestamp() else null end,
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        last_error = left(coalesce(input_error, 'Calendar invitation handoff failed'), 4000),
        updated_at = statement_timestamp()
    where id = input_id and status = 'processing' and lease_token = input_lease_token
    returning 1
  ) select exists(select 1 from failed)
$$;

alter table calendar_invitation_deliveries enable row level security;
alter table calendar_invitation_deliveries force row level security;
create policy helix_tenant_isolation on calendar_invitation_deliveries
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());
alter table calendar_invitation_delivery_events enable row level security;
alter table calendar_invitation_delivery_events force row level security;
create policy helix_tenant_isolation on calendar_invitation_delivery_events
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());

revoke all on calendar_invitation_deliveries, calendar_invitation_delivery_events
  from public, helix_readonly;
grant select, insert, update on calendar_invitation_deliveries to helix_app, helix_worker;
grant select on calendar_invitation_delivery_events to helix_app, helix_worker;
revoke execute on function helix_calendar_invitation_delivery_audit(),
  helix_claim_calendar_invitation_deliveries(text, integer, integer),
  helix_complete_calendar_invitation_delivery(uuid, uuid, uuid),
  helix_fail_calendar_invitation_delivery(uuid, uuid, text, integer, integer)
from public;
grant execute on function helix_claim_calendar_invitation_deliveries(text, integer, integer),
  helix_complete_calendar_invitation_delivery(uuid, uuid, uuid),
  helix_fail_calendar_invitation_delivery(uuid, uuid, text, integer, integer)
to helix_app, helix_worker;
