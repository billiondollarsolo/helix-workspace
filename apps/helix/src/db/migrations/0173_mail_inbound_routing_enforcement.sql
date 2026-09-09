-- Enforce tenant-owned inbound routing in the SMTP delivery path.

alter table mail_outbound_messages
  add column idempotency_key text,
  add constraint mail_outbound_idempotency_key_check check (
    idempotency_key is null or char_length(idempotency_key) between 1 and 512
  );
create unique index mail_outbound_idempotency_key_uidx
  on mail_outbound_messages (org_id, idempotency_key)
  where idempotency_key is not null;

create table mail_journal_settings (
  org_id uuid primary key references orgs(id) on delete cascade,
  enabled boolean not null default false,
  retention_days integer not null default 2555 check (retention_days between 1 and 36500),
  updated_by_actor_id uuid not null,
  updated_at timestamptz not null default statement_timestamp(),
  foreign key (org_id, updated_by_actor_id) references actors(org_id, id)
);

create table mail_journal_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  message_id uuid not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  custodians uuid[] not null,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  previous_sha256 text check (previous_sha256 ~ '^[a-f0-9]{64}$'),
  retention_until timestamptz not null,
  created_at timestamptz not null default statement_timestamp(),
  unique (org_id, message_id),
  unique (org_id, content_sha256)
);
create index mail_journal_expiry_idx on mail_journal_entries (retention_until, org_id, id);

alter table mail_journal_settings enable row level security;
alter table mail_journal_settings force row level security;
create policy helix_tenant_isolation on mail_journal_settings
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());
alter table mail_journal_entries enable row level security;
alter table mail_journal_entries force row level security;
create policy helix_tenant_isolation on mail_journal_entries
  for select using (org_id = helix_current_org_id());

create function helix_record_mail_journal(input_org_id uuid, input_message_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  configured_retention integer;
  journal_direction text;
  journal_custodians uuid[];
  journal_snapshot jsonb;
  previous_hash text;
begin
  if public.helix_current_org_id() is distinct from input_org_id then
    raise insufficient_privilege using message = 'invalid mail journal tenant context';
  end if;
  select retention_days into configured_retention
  from public.mail_journal_settings where org_id = input_org_id and enabled;
  if configured_retention is null then return false; end if;

  select message.metadata->>'direction',
    public.helix_governance_item_custodians(input_org_id, 'mail', 'message', message.id),
    jsonb_build_object(
      'message', to_jsonb(message),
      'thread', to_jsonb(thread),
      'attachments', coalesce((
        select jsonb_agg(jsonb_build_object(
          'objectId', object.id, 'storageKey', object.storage_key,
          'sha256', object.sha256, 'byteSize', object.byte_size
        ) order by object.id)
        from public.message_attachments attachment
        join public.objects object on object.org_id = attachment.org_id and object.id = attachment.object_id
        where attachment.org_id = input_org_id and attachment.message_id = message.id
      ), '[]'::jsonb),
      'rawSource', (
        select jsonb_build_object(
          'objectId', object.id, 'storageKey', object.storage_key,
          'sha256', object.sha256, 'byteSize', object.byte_size
        )
        from public.mail_raw_sources source
        join public.objects object on object.org_id = source.org_id and object.id = source.object_id
        where source.org_id = input_org_id and source.message_id = message.id
      )
    )
  into journal_direction, journal_custodians, journal_snapshot
  from public.messages message
  join public.threads thread on thread.org_id = message.org_id and thread.id = message.thread_id
  where message.org_id = input_org_id and message.id = input_message_id and message.kind = 'mail';
  if journal_snapshot is null then raise no_data_found using message = 'mail journal source missing'; end if;
  if journal_direction not in ('inbound', 'outbound') then
    raise check_violation using message = 'mail journal direction missing';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('mail-journal:' || input_org_id::text, 0));
  select content_sha256 into previous_hash
  from public.mail_journal_entries where org_id = input_org_id
  order by created_at desc, id desc limit 1;
  insert into public.mail_journal_entries (
    org_id, message_id, direction, custodians, snapshot, content_sha256,
    previous_sha256, retention_until
  ) values (
    input_org_id, input_message_id, journal_direction, journal_custodians, journal_snapshot,
    encode(digest(convert_to(coalesce(previous_hash, '') || ':' || journal_snapshot::text, 'UTF8'), 'sha256'), 'hex'),
    previous_hash, statement_timestamp() + make_interval(days => configured_retention)
  ) on conflict (org_id, message_id) do nothing;
  return found;
end
$$;

create function helix_purge_expired_mail_journal(input_limit integer, input_due_before timestamptz)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare purged integer;
begin
  if input_limit not between 1 and 500 or input_due_before > statement_timestamp() then
    raise invalid_parameter_value using message = 'invalid mail journal purge bound';
  end if;
  with due as (
    select entry.id
    from public.mail_journal_entries entry
    where entry.retention_until <= input_due_before
      and not public.helix_governance_is_held(
        entry.org_id, 'mail', 'message', entry.message_id, entry.custodians
      )
    order by entry.retention_until, entry.org_id, entry.id
    limit input_limit for update skip locked
  ), removed as (
    delete from public.mail_journal_entries entry using due
    where entry.id = due.id returning 1
  ) select count(*)::integer into purged from removed;
  return purged;
end
$$;

create function helix_guard_journaled_mail_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  if old.kind = 'mail' and exists (
    select 1 from public.mail_journal_entries entry
    where entry.org_id = old.org_id and entry.message_id = old.id
      and (
        entry.retention_until > statement_timestamp()
        or public.helix_governance_is_held(
          entry.org_id, 'mail', 'message', entry.message_id, entry.custodians
        )
      )
  ) then
    raise integrity_constraint_violation using message = 'mail is protected by compliance journal';
  end if;
  return old;
end
$$;

create trigger mail_journal_message_delete_guard
before delete on messages
for each row execute function helix_guard_journaled_mail_delete();

create or replace function helix_tenant_deletion_blockers(input_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select coalesce(jsonb_agg(blocker order by blocker->>'type'), '[]'::jsonb)
  from (
    select jsonb_build_object('type', 'mail_hold', 'count', count(*)) blocker
    from mail_retention_holds where org_id = input_org_id
      and (expires_at is null or expires_at > statement_timestamp()) having count(*) > 0
    union all select jsonb_build_object('type', 'drive_hold', 'count', count(*))
    from drive_retention_holds where org_id = input_org_id and released_at is null
      and (expires_at is null or expires_at > statement_timestamp()) having count(*) > 0
    union all select jsonb_build_object('type', 'drive_retention', 'count', count(*))
    from (select id from objects where org_id = input_org_id and retain_until > statement_timestamp()
      union all select id from drive_folders where org_id = input_org_id
        and retain_until > statement_timestamp()) retained_drive having count(*) > 0
    union all select jsonb_build_object('type', 'recording_hold_or_retention', 'count', count(*))
    from meet_recording_governance where org_id = input_org_id
      and (legal_hold or retention_until > statement_timestamp()) having count(*) > 0
    union all select jsonb_build_object('type', 'contact_hold_or_retention', 'count', count(*))
    from carddav_contacts where org_id = input_org_id
      and (legal_hold or retain_until > statement_timestamp()) having count(*) > 0
    union all select jsonb_build_object('type', 'mail_journal_retention', 'count', count(*))
    from mail_journal_entries where org_id = input_org_id
      and retention_until > statement_timestamp() having count(*) > 0
    union all select jsonb_build_object('type', 'governance_legal_hold', 'count', count(*))
    from governance_legal_holds where org_id = input_org_id and released_at is null having count(*) > 0
    union all select jsonb_build_object('type', 'governance_retention', 'count', count(*))
    from helix_governance_items(input_org_id) item
    where helix_governance_retention_until(
      input_org_id, item.product, item.occurred_at, item.custodians
    ) > statement_timestamp() having count(*) > 0
  ) blockers
$$;

create or replace function helix_mail_pattern_is_local(tenant_id uuid, pattern text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.admin_domains domain
    where domain.org_id = tenant_id
      and domain.domain = case
        when lower(btrim(pattern)) like '*@%' then substr(lower(btrim(pattern)), 3)
        else split_part(lower(btrim(pattern)), '@', 2)
      end
      and domain.status = 'verified' and domain.mail_enabled and domain.verified_at is not null
      and lower(btrim(pattern)) ~ '^(\*|[^@*[:space:]]+)@[^@*[:space:]]+$'
  )
$$;

create or replace function helix_validate_mail_routing_rule()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  source_address text := lower(btrim(new.match->>'recipientPattern'));
  target_address text;
begin
  if jsonb_typeof(new.match) <> 'object'
    or jsonb_typeof(new.action) <> 'object'
    or new.match - 'recipientPattern' - 'senderPattern' - 'subjectContains'
      - 'headerName' - 'headerContains' <> '{}'::jsonb
    or new.action - 'forwardTo' - 'aliasActorId' - 'tag' - 'mailbox'
      - 'stopProcessing' <> '{}'::jsonb
  then
    raise check_violation using message = 'invalid mail routing rule shape';
  end if;
  if (new.match ? 'recipientPattern' and jsonb_typeof(new.match->'recipientPattern') <> 'string')
    or (new.match ? 'senderPattern' and jsonb_typeof(new.match->'senderPattern') <> 'string')
    or (new.match ? 'subjectContains' and (
      jsonb_typeof(new.match->'subjectContains') <> 'string'
      or char_length(new.match->>'subjectContains') not between 1 and 998
    ))
    or (new.match ? 'headerName' and jsonb_typeof(new.match->'headerName') <> 'string')
    or (new.match ? 'headerContains' and (
      jsonb_typeof(new.match->'headerContains') <> 'string'
      or char_length(new.match->>'headerContains') not between 1 and 998
    ))
    or (new.action ? 'stopProcessing'
      and jsonb_typeof(new.action->'stopProcessing') <> 'boolean')
  then
    raise check_violation using message = 'invalid mail routing rule value';
  end if;

  if source_address is not null and not public.helix_mail_pattern_is_local(new.org_id, source_address)
  then
    raise check_violation using message = 'recipient pattern must use a verified mail domain';
  end if;
  if new.match ? 'senderPattern'
    and lower(btrim(new.match->>'senderPattern')) !~ '^(\*|[^@*[:space:]]+)@[^@*[:space:]]+$'
  then
    raise check_violation using message = 'invalid sender pattern';
  end if;
  if new.match ? 'headerName'
    and btrim(new.match->>'headerName') !~ '^[!#$%&''*+.^_`|~0-9A-Za-z-]{1,128}$'
  then
    raise check_violation using message = 'invalid header name';
  end if;
  if (new.match ? 'headerName') <> (new.match ? 'headerContains') then
    raise check_violation using message = 'headerName and headerContains must be provided together';
  end if;

  case new.action_kind
    when 'alias' then
      if new.action - 'stopProcessing' - 'aliasActorId' <> '{}'::jsonb
        or source_address is null or (new.action->>'aliasActorId') is null or not exists (
        select 1
        from public.actors actor
        join public.organization_memberships membership
          on membership.org_id = actor.org_id and membership.actor_id = actor.id
        where actor.org_id = new.org_id
          and actor.id = (new.action->>'aliasActorId')::uuid
          and actor.type = 'user' and actor.disabled_at is null
          and membership.status = 'active' and membership.guest_type = 'member'
      ) then
        raise check_violation using message = 'alias target must be an active member mailbox';
      end if;
    when 'mailbox' then
      target_address := lower(btrim(new.action->>'mailbox'));
      if new.action - 'stopProcessing' - 'mailbox' <> '{}'::jsonb
        or source_address is null
        or not public.helix_mail_address_is_local(new.org_id, target_address)
      then
        raise check_violation using message = 'mailbox target must be an active local address';
      end if;
      new.action := jsonb_set(new.action, '{mailbox}', to_jsonb(target_address));
    when 'tag' then
      if new.action - 'stopProcessing' - 'tag' <> '{}'::jsonb
        or nullif(btrim(new.action->>'tag'), '') is null
        or char_length(new.action->>'tag') > 128
      then
        raise check_violation using message = 'tag action requires a bounded tag';
      end if;
    when 'forward' then
      if new.action - 'stopProcessing' - 'forwardTo' <> '{}'::jsonb
        or source_address is null or source_address like '*@%'
        or not public.helix_mail_address_is_local(new.org_id, source_address)
      then
        raise check_violation using message = 'forwarding requires one exact active local source';
      end if;
      target_address := lower(btrim(new.action->>'forwardTo'));
      if target_address is null or target_address !~ '^[^@*[:space:]]+@[^@*[:space:]]+$' then
        raise check_violation using message = 'forward target must be one email address';
      end if;
      new.action := jsonb_set(new.action, '{forwardTo}', to_jsonb(target_address));
      if exists (
        select 1 from public.admin_domains domain
        where domain.org_id = new.org_id
          and domain.domain = split_part(target_address, '@', 2)
          and domain.status <> 'released'
      ) then
        if not public.helix_mail_address_is_local(new.org_id, target_address) then
          raise check_violation using message = 'internal forward target must be active';
        end if;
      elsif not public.helix_external_mail_forward_allowed(new.org_id, target_address) then
        raise check_violation using message = 'external forwarding is blocked by policy';
      end if;
      if exists (
        with recursive edges(source, target) as (
          select lower(btrim(rule.match->>'recipientPattern')),
                 lower(btrim(rule.action->>'forwardTo'))
          from public.mail_inbound_routing_rules rule
          where rule.org_id = new.org_id and rule.is_enabled
            and rule.action_kind = 'forward' and rule.id <> new.id
          union all values (source_address, target_address)
        ), walk(address, depth) as (
          values (target_address, 0)
          union
          select edge.target, walk.depth + 1
          from walk join edges edge on edge.source = walk.address
          where walk.depth < 100
        )
        select 1 from walk where address = source_address
      ) then
        raise check_violation using message = 'mail forwarding cycle detected';
      end if;
    when 'drop' then
      if new.action - 'stopProcessing' <> '{}'::jsonb then
        raise check_violation using message = 'drop action accepts only stopProcessing';
      end if;
  end case;

  if source_address is not null then
    new.match := jsonb_set(new.match, '{recipientPattern}', to_jsonb(source_address));
  end if;
  return new;
exception
  when invalid_text_representation then
    raise check_violation using message = 'invalid routing target identifier';
end
$$;

create or replace function helix_resolve_inbound_routing_rules(
  requested_address text,
  requested_domain text
)
returns table (
  id uuid,
  org_id uuid,
  priority integer,
  match jsonb,
  action_kind mail_routing_action_kind,
  action jsonb,
  target_actor_id uuid,
  target_address text,
  target_quota_exceeded boolean,
  source_actor_id uuid,
  source_address text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select rule.id, rule.org_id, rule.priority, rule.match, rule.action_kind, rule.action,
    target.actor_id, target.address, target.quota_exceeded,
    source.actor_id, source.address
  from public.admin_domains domain
  join public.orgs org on org.id = domain.org_id
  join public.mail_inbound_routing_rules rule on rule.org_id = domain.org_id and rule.is_enabled
  left join lateral (
    select resolved.actor_id, resolved.address, resolved.quota_exceeded
    from public.helix_resolve_inbound_mailboxes(
      case rule.action_kind
        when 'alias' then (
          select actor.email from public.actors actor
          where actor.org_id = rule.org_id and actor.id = (rule.action->>'aliasActorId')::uuid
        )
        when 'mailbox' then rule.action->>'mailbox'
      end,
      split_part(case rule.action_kind
        when 'alias' then (
          select actor.email from public.actors actor
          where actor.org_id = rule.org_id and actor.id = (rule.action->>'aliasActorId')::uuid
        )
        when 'mailbox' then rule.action->>'mailbox'
      end, '@', 2)
    ) resolved
    where rule.action_kind in ('alias', 'mailbox')
  ) target on true
  left join lateral (
    select resolved.actor_id, lower(actor.email) as address
    from public.helix_resolve_inbound_mailboxes(requested_address, requested_domain) resolved
    join public.actors actor on actor.org_id = resolved.org_id and actor.id = resolved.actor_id
    where rule.action_kind = 'forward'
    order by resolved.actor_id
    limit 1
  ) source on true
  where domain.domain = lower(btrim(requested_domain))
    and domain.status = 'verified' and domain.mail_enabled and domain.verified_at is not null
    and org.status = 'active' and org.suspended_at is null
    and org.soft_deleted_at is null and org.hard_deleted_at is null
    and (
      (not (rule.match ? 'recipientPattern')
        and public.helix_mail_address_is_local(rule.org_id, requested_address))
      or lower(btrim(rule.match->>'recipientPattern')) = lower(btrim(requested_address))
      or (
        lower(btrim(rule.match->>'recipientPattern')) = '*@' || lower(btrim(requested_domain))
        and split_part(lower(btrim(requested_address)), '@', 2) = lower(btrim(requested_domain))
      )
    )
  order by rule.priority, rule.created_at, rule.id, target.actor_id
$$;

alter function helix_mail_pattern_is_local(uuid, text) owner to helix_migration_owner;
alter function helix_validate_mail_routing_rule() owner to helix_migration_owner;
alter function helix_resolve_inbound_routing_rules(text, text) owner to helix_migration_owner;
alter function helix_record_mail_journal(uuid, uuid) owner to helix_migration_owner;
alter function helix_purge_expired_mail_journal(integer, timestamptz) owner to helix_migration_owner;
alter function helix_guard_journaled_mail_delete() owner to helix_migration_owner;
alter function helix_tenant_deletion_blockers(uuid) owner to helix_migration_owner;
alter table mail_journal_settings owner to helix_migration_owner;
alter table mail_journal_entries owner to helix_migration_owner;
revoke all on function helix_mail_pattern_is_local(uuid, text) from public;
revoke all on function helix_validate_mail_routing_rule() from public;
revoke all on function helix_resolve_inbound_routing_rules(text, text) from public;
revoke all on function helix_record_mail_journal(uuid, uuid) from public;
revoke all on function helix_purge_expired_mail_journal(integer, timestamptz) from public;
revoke all on function helix_guard_journaled_mail_delete() from public;
revoke all on function helix_tenant_deletion_blockers(uuid) from public;
revoke all on mail_journal_settings, mail_journal_entries
  from public, helix_app, helix_worker, helix_readonly;
grant execute on function helix_resolve_inbound_routing_rules(text, text) to helix_app;
grant execute on function helix_record_mail_journal(uuid, uuid) to helix_app;
grant execute on function helix_purge_expired_mail_journal(integer, timestamptz)
  to helix_app, helix_worker;
grant execute on function helix_tenant_deletion_blockers(uuid) to helix_app, helix_worker;
grant select, insert, update on mail_journal_settings to helix_app;
grant select on mail_journal_entries to helix_app;
grant select on mail_journal_settings, mail_journal_entries to helix_readonly;

update mail_inbound_routing_rules set match = match where is_enabled;
