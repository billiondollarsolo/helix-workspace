-- Limits for one person, agent or service account, managed from Admin → Users.
--
-- An organization sets a default for everyone under Admin → Workspace settings
-- → Limits (orgs.quotas: storage_bytes_per_person_limit,
-- mail_send_per_hour_limit, mail_send_per_day_limit). A row here overrides a
-- default for one actor; a null column means "use the organization's default".
--
-- A person's storage is the Drive files and recordings they own plus the mail
-- in their mailbox. It is counted when it is needed, not kept in a counter, so
-- it cannot drift from what is stored.

create table actor_limits (
  org_id uuid not null references orgs (id) on delete cascade,
  actor_id uuid not null,
  storage_bytes_limit bigint check (storage_bytes_limit >= 0),
  mail_send_per_hour integer check (mail_send_per_hour >= 0),
  mail_send_per_day integer check (mail_send_per_day >= 0),
  updated_by_actor_id uuid,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (org_id, actor_id),
  constraint actor_limits_actor_fk
    foreign key (org_id, actor_id) references actors (org_id, id) on delete cascade,
  constraint actor_limits_updated_by_fk
    foreign key (org_id, updated_by_actor_id)
    references actors (org_id, id) on delete set null (updated_by_actor_id)
);

alter table actor_limits enable row level security;
alter table actor_limits force row level security;
create policy helix_tenant_isolation on actor_limits
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
create policy helix_tenant_boundary on actor_limits as restrictive for all
  using (org_id = public.helix_current_org_id())
  with check (org_id = public.helix_current_org_id());

-- Counting what one person sent in the last hour and day.
create index mail_outbound_actor_created_idx
  on mail_outbound_messages (org_id, actor_id, created_at desc);

-- The functions below are security definer because a person's storage has to
-- be known where their rows are not readable: while a sending server is asking
-- whether their mailbox will take a message, before any organization context
-- exists, and when an administrator looks at someone else. Only the server's
-- own roles may execute them, always with an organization and actor it has
-- already resolved.

-- Bytes one actor is using: Drive files and recordings they own (trash
-- included, since trashed files still take space), plus each message in
-- their mailbox, measured by its stored source when it came from outside and
-- by its text and attachments when it was written in Helix.
create function helix_actor_storage_usage_bytes(input_org_id uuid, input_actor_id uuid)
returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select (
    coalesce((
      select sum(object.byte_size)
      from public.objects object
      where object.org_id = input_org_id
        and object.owner_actor_id = input_actor_id
        and object.kind::text in ('file', 'recording')
    ), 0)
    + coalesce((
      select sum(coalesce(
        source.byte_size,
        octet_length(message.body) + coalesce(attached.byte_size, 0)
      ))
      from public.mail_message_deliveries delivery
      join public.messages message
        on message.org_id = delivery.org_id and message.id = delivery.message_id
      left join public.mail_raw_sources raw
        on raw.org_id = message.org_id and raw.message_id = message.id
      left join public.objects source
        on source.org_id = raw.org_id and source.id = raw.object_id
      left join lateral (
        select sum(coalesce(ingestion.actual_byte_size, ingestion.expected_byte_size)) as byte_size
        from public.mail_attachment_ingestions ingestion
        where ingestion.org_id = message.org_id
          and ingestion.message_id = message.id
          and ingestion.status::text = 'attached'
      ) attached on true
      where delivery.org_id = input_org_id
        and delivery.actor_id = input_actor_id
        and message.deleted_at is null
    ), 0)
  )::bigint
$$;

-- One actor's storage limit: their own, else the organization's default for
-- each person, else none (null).
create function helix_actor_storage_limit_bytes(input_org_id uuid, input_actor_id uuid)
returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select coalesce(
    (
      select own.storage_bytes_limit
      from public.actor_limits own
      where own.org_id = input_org_id and own.actor_id = input_actor_id
    ),
    nullif(org.quotas->>'storage_bytes_per_person_limit', '')::bigint
  )
  from public.orgs org
  where org.id = input_org_id
$$;

-- Whether `additional_bytes` more would take the actor past their limit. With
-- nothing to add, whether they have already reached it. An actor with no limit
-- is never full, and nothing is counted for them.
create function helix_actor_storage_full(
  input_org_id uuid,
  input_actor_id uuid,
  additional_bytes bigint default 0
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select case
    when quota.limit_bytes is null then false
    when additional_bytes > 0 then
      public.helix_actor_storage_usage_bytes(input_org_id, input_actor_id) + additional_bytes
        > quota.limit_bytes
    else public.helix_actor_storage_usage_bytes(input_org_id, input_actor_id) >= quota.limit_bytes
  end
  from (
    select public.helix_actor_storage_limit_bytes(input_org_id, input_actor_id) as limit_bytes
  ) quota
$$;

alter function helix_actor_storage_usage_bytes(uuid, uuid) owner to helix_migration_owner;
alter function helix_actor_storage_limit_bytes(uuid, uuid) owner to helix_migration_owner;
alter function helix_actor_storage_full(uuid, uuid, bigint) owner to helix_migration_owner;
revoke all on function helix_actor_storage_usage_bytes(uuid, uuid) from public;
revoke all on function helix_actor_storage_limit_bytes(uuid, uuid) from public;
revoke all on function helix_actor_storage_full(uuid, uuid, bigint) from public;
grant execute on function helix_actor_storage_usage_bytes(uuid, uuid) to helix_app, helix_worker;
grant execute on function helix_actor_storage_limit_bytes(uuid, uuid) to helix_app, helix_worker;
grant execute on function helix_actor_storage_full(uuid, uuid, bigint) to helix_app, helix_worker;

-- Messages one actor queued to send since `input_since`. Mail that was
-- cancelled does not count, nor do notices Helix sends in a person's name
-- (their idempotency key starts with 'notice:').
create function helix_actor_mail_sent_count(
  input_org_id uuid,
  input_actor_id uuid,
  input_since timestamptz
)
returns integer
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select count(*)::integer
  from public.mail_outbound_messages outbound
  where outbound.org_id = input_org_id
    and outbound.actor_id = input_actor_id
    and outbound.created_at > input_since
    and outbound.cancelled_at is null
    and (outbound.idempotency_key is null or outbound.idempotency_key not like 'notice:%')
$$;

alter function helix_actor_mail_sent_count(uuid, uuid, timestamptz) owner to helix_migration_owner;
revoke all on function helix_actor_mail_sent_count(uuid, uuid, timestamptz) from public;
grant execute on function helix_actor_mail_sent_count(uuid, uuid, timestamptz)
  to helix_app, helix_worker;

-- Three organization limits were stored and shown but never applied anywhere:
-- accounts, AI tokens a month and AI images a month. They are removed from the
-- settings; drop any saved values so nothing suggests they are in force.
update orgs
set quotas = quotas - 'actors_limit' - 'ai_tokens_monthly_limit' - 'ai_image_gen_monthly_limit'
where quotas ?| array['actors_limit', 'ai_tokens_monthly_limit', 'ai_image_gen_monthly_limit'];
