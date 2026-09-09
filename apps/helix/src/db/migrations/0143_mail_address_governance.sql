-- MAIL-24: one authoritative address-governance boundary for aliases,
-- mailbox delegation, inbound forwarding, and mailing-list expansion.

alter table mail_aliases
  add column receive_enabled boolean not null default true,
  add column send_as_enabled boolean not null default true,
  add constraint mail_aliases_delivery_modes_check check (
    not enabled or receive_enabled or send_as_enabled
  );

alter table mail_aliases
  drop constraint if exists mail_aliases_actor_id_fkey,
  add constraint mail_aliases_actor_org_fk
    foreign key (org_id, actor_id) references actors (org_id, id) on delete restrict;

create or replace function helix_validate_alias_address()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  new.email := lower(btrim(new.email));
  if new.enabled and new.disabled_at is null then
    if not exists (
      select 1
      from public.actors actor
      join public.organization_memberships membership
        on membership.org_id = actor.org_id and membership.actor_id = actor.id
      where actor.org_id = new.org_id and actor.id = new.actor_id
        and actor.type = 'user' and actor.disabled_at is null
        and membership.status = 'active' and membership.guest_type = 'member'
    ) then
      raise check_violation using
        constraint = 'mail_aliases_active_target_check',
        message = 'mail alias target must be an active member mailbox in the same organization';
    end if;
    perform public.helix_assert_directory_address(new.org_id, new.email, 'alias', new.id);
  end if;
  return new;
end
$$;

drop trigger if exists mail_aliases_address_guard on mail_aliases;
create constraint trigger mail_aliases_address_guard
after insert or update of org_id, actor_id, email, enabled, disabled_at,
  receive_enabled, send_as_enabled on mail_aliases
deferrable initially deferred
for each row execute function helix_validate_alias_address();

update mail_aliases set email = email
where enabled and disabled_at is null;

create or replace function helix_validate_mailbox_permission()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.resource_type <> 'mailbox' or new.status <> 'active' then
    return new;
  end if;
  if new.actor_id = new.resource_id
    or new.role <> 'manager'
    or new.granted_by_actor_id is distinct from new.resource_id
    or not exists (
      select 1
      from public.actors delegate
      join public.organization_memberships membership
        on membership.org_id = delegate.org_id and membership.actor_id = delegate.id
      where delegate.org_id = new.org_id and delegate.id = new.actor_id
        and delegate.type = 'user' and delegate.disabled_at is null
        and membership.status = 'active' and membership.guest_type = 'member'
    )
    or not exists (
      select 1
      from public.actors owner
      join public.organization_memberships membership
        on membership.org_id = owner.org_id and membership.actor_id = owner.id
      where owner.org_id = new.org_id and owner.id = new.resource_id
        and owner.type = 'user' and owner.disabled_at is null
        and membership.status = 'active' and membership.guest_type = 'member'
    )
  then
    raise check_violation using
      constraint = 'permissions_mailbox_scope_check',
      message = 'mailbox delegation requires an explicit active owner grant to another active member';
  end if;
  return new;
end
$$;

update permissions set resource_id = resource_id
where resource_type = 'mailbox' and status = 'active';

-- Exact local address predicate used by the forwarding validator. Pattern
-- routing remains available for tag/drop; redirecting mail requires an exact,
-- owned source so cycles and ownership are decidable.
create function helix_mail_address_is_local(tenant_id uuid, candidate text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with normalized as (
    select lower(btrim(candidate)) as address
  )
  select exists (
    select 1
    from normalized
    join public.admin_domains domain
      on domain.org_id = tenant_id
     and domain.domain = split_part(normalized.address, '@', 2)
     and domain.status = 'verified' and domain.mail_enabled
    where normalized.address ~ '^[^@[:space:]]+@[^@[:space:]]+$'
      and (
        exists (
          select 1
          from public.actors actor
          join public.organization_memberships membership
            on membership.org_id = actor.org_id and membership.actor_id = actor.id
          where actor.org_id = tenant_id and actor.type = 'user'
            and actor.disabled_at is null and membership.status = 'active'
            and membership.guest_type = 'member'
            and public.helix_canonical_login_email(tenant_id, actor.email)
              = public.helix_canonical_login_email(tenant_id, normalized.address)
        )
        or exists (
          select 1 from public.mail_aliases alias
          where alias.org_id = tenant_id and alias.enabled and alias.disabled_at is null
            and alias.receive_enabled and lower(alias.email) = normalized.address
        )
        or exists (
          select 1 from public.admin_groups group_record
          where group_record.org_id = tenant_id and group_record.kind = 'mailing_list'
            and lower(group_record.email) = normalized.address
        )
      )
  )
$$;

create function helix_external_mail_forward_allowed(tenant_id uuid, target_address text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce((
    select policy.enabled and case policy.settings->>'mode'
      when 'anyone' then true
      when 'allowlist' then exists (
        select 1
        from jsonb_array_elements_text(coalesce(policy.settings->'allowedDomains', '[]'::jsonb)) entry
        where lower(entry) = split_part(lower(btrim(target_address)), '@', 2)
      )
      else false
    end
    from public.admin_security_policies policy
    where policy.org_id = tenant_id and policy.policy_type = 'external_sharing'
  ), false)
$$;

create function helix_validate_mail_routing_rule()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  source_address text := lower(btrim(new.match->>'recipientPattern'));
  target_address text;
begin
  if new.action_kind not in ('forward', 'alias') then
    return new;
  end if;
  if source_address is null
    or source_address !~ '^[^@[:space:]]+@[^@[:space:]]+$'
    or not public.helix_mail_address_is_local(new.org_id, source_address)
  then
    raise check_violation using
      constraint = 'mail_routing_owned_source_check',
      message = 'redirect routing requires an exact active address owned by the organization';
  end if;
  new.match := jsonb_set(new.match, '{recipientPattern}', to_jsonb(source_address));

  if new.action_kind = 'alias' then
    if (new.action->>'aliasActorId') is null or not exists (
      select 1
      from public.actors actor
      join public.organization_memberships membership
        on membership.org_id = actor.org_id and membership.actor_id = actor.id
      where actor.org_id = new.org_id
        and actor.id = (new.action->>'aliasActorId')::uuid
        and actor.type = 'user' and actor.disabled_at is null
        and membership.status = 'active' and membership.guest_type = 'member'
    ) then
      raise check_violation using
        constraint = 'mail_routing_alias_target_check',
        message = 'alias routing target must be an active member mailbox in the same organization';
    end if;
    return new;
  end if;

  target_address := lower(btrim(new.action->>'forwardTo'));
  if target_address is null or target_address !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    raise check_violation using
      constraint = 'mail_routing_forward_target_check',
      message = 'forward target must be one email address';
  end if;
  new.action := jsonb_set(new.action, '{forwardTo}', to_jsonb(target_address));

  if exists (
    select 1 from public.admin_domains domain
    where domain.org_id = new.org_id
      and domain.domain = split_part(target_address, '@', 2)
      and domain.status <> 'released'
  ) then
    if not public.helix_mail_address_is_local(new.org_id, target_address) then
      raise check_violation using
        constraint = 'mail_routing_forward_target_check',
        message = 'internal forward target must resolve to an active local address';
    end if;
  elsif not public.helix_external_mail_forward_allowed(new.org_id, target_address) then
    raise check_violation using
      constraint = 'mail_routing_external_policy_check',
      message = 'external forwarding is blocked by organization policy';
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
    raise check_violation using
      constraint = 'mail_routing_forward_cycle_check',
      message = 'mail forwarding cycle detected';
  end if;
  return new;
end
$$;

drop trigger if exists mail_inbound_routing_rules_governance on mail_inbound_routing_rules;
create trigger mail_inbound_routing_rules_governance
before insert or update of org_id, is_enabled, match, action_kind, action
on mail_inbound_routing_rules
for each row when (new.is_enabled)
execute function helix_validate_mail_routing_rule();

update mail_inbound_routing_rules set match = match
where is_enabled and action_kind in ('forward', 'alias');

create table mail_address_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  event_type text not null check (event_type in (
    'alias_created', 'alias_updated', 'alias_disabled',
    'delegate_granted', 'delegate_revoked',
    'routing_created', 'routing_updated', 'routing_deleted'
  )),
  actor_id text,
  object_type text not null,
  object_id uuid not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index mail_address_events_org_created_idx
  on mail_address_events (org_id, created_at, id);

create function helix_audit_mail_address_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  row_value record := case when tg_op = 'DELETE' then old else new end;
  kind text;
begin
  if tg_table_name = 'mail_aliases' then
    kind := case
      when tg_op = 'INSERT' then 'alias_created'
      when old.disabled_at is null and new.disabled_at is not null then 'alias_disabled'
      else 'alias_updated'
    end;
    insert into public.mail_address_events (
      org_id, event_type, actor_id, object_type, object_id, details
    ) values (
      row_value.org_id, kind, nullif(current_setting('helix.actor_id', true), ''),
      'mail_alias', row_value.id,
      jsonb_build_object('targetActorId', row_value.actor_id, 'address', row_value.email,
        'receiveEnabled', row_value.receive_enabled, 'sendAsEnabled', row_value.send_as_enabled)
    );
  elsif tg_table_name = 'permissions' then
    if tg_op = 'INSERT' then
      kind := 'delegate_granted';
    elsif old.status = 'active' and new.status = 'revoked' then
      kind := 'delegate_revoked';
    else
      return new;
    end if;
    insert into public.mail_address_events (
      org_id, event_type, actor_id, object_type, object_id, details
    ) values (
      row_value.org_id, kind, row_value.granted_by_actor_id,
      'mailbox_delegate', row_value.id,
      jsonb_build_object('ownerActorId', row_value.resource_id,
        'delegateActorId', row_value.actor_id, 'expiresAt', row_value.expires_at)
    );
  else
    kind := case tg_op when 'INSERT' then 'routing_created'
      when 'UPDATE' then 'routing_updated' else 'routing_deleted' end;
    insert into public.mail_address_events (
      org_id, event_type, actor_id, object_type, object_id, details
    ) values (
      row_value.org_id, kind, coalesce(row_value.created_by::text,
        nullif(current_setting('helix.actor_id', true), '')),
      'mail_routing_rule', row_value.id,
      jsonb_build_object('actionKind', row_value.action_kind, 'enabled', row_value.is_enabled)
    );
  end if;
  return row_value;
end
$$;

create trigger mail_aliases_audit
after insert or update on mail_aliases
for each row execute function helix_audit_mail_address_change();

create trigger permissions_mailbox_audit
after insert or update on permissions
for each row when (new.resource_type = 'mailbox')
execute function helix_audit_mail_address_change();

create trigger mail_routing_rules_audit
after insert or update or delete on mail_inbound_routing_rules
for each row execute function helix_audit_mail_address_change();

create function helix_reject_mail_address_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'mail address audit events are immutable' using errcode = '55000';
end
$$;

create trigger mail_address_events_no_update_or_delete
before update or delete on mail_address_events
for each statement execute function helix_reject_mail_address_event_mutation();

alter table mail_address_events enable row level security;
alter table mail_address_events force row level security;
create policy helix_tenant_isolation on mail_address_events
  using (org_id = helix_current_org_id()) with check (false);

-- Inbound resolution now returns every mailbox represented by a direct,
-- receive-enabled alias, exact alias-routing rule, or mailing list. The hard
-- bound applies after de-duplication so a list cannot amplify one SMTP RCPT.
create function helix_resolve_inbound_mailboxes(
  requested_address text,
  requested_domain text,
  max_recipient_count integer default 100
)
returns table (org_id uuid, actor_id uuid, address text, quota_exceeded boolean)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  recipient_count integer;
begin
  if max_recipient_count < 1 or max_recipient_count > 1000 then
    raise invalid_parameter_value using message = 'invalid recipient expansion limit';
  end if;

  select count(distinct candidate.actor_id)::integer into recipient_count
  from (
    select actor.id as actor_id
    from public.admin_domains domain
    left join public.admin_domains target on target.id = domain.alias_target_domain_id
    join public.actors actor on actor.org_id = domain.org_id
    join public.organization_memberships membership
      on membership.org_id = actor.org_id and membership.actor_id = actor.id
    where domain.domain = lower(btrim(requested_domain))
      and domain.domain = split_part(lower(btrim(requested_address)), '@', 2)
      and domain.status = 'verified' and domain.mail_enabled and domain.verified_at is not null
      and (domain.identity_mode = 'secondary'
        or (target.status = 'verified' and target.identity_enabled and target.identity_mode = 'secondary'))
      and actor.type = 'user' and actor.disabled_at is null
      and membership.status = 'active' and membership.guest_type = 'member'
      and lower(actor.email) = split_part(lower(btrim(requested_address)), '@', 1) || '@' ||
        case domain.identity_mode when 'alias' then target.domain else domain.domain end
    union
    select alias.actor_id
    from public.admin_domains domain
    join public.mail_aliases alias on alias.org_id = domain.org_id
    join public.actors actor on actor.org_id = alias.org_id and actor.id = alias.actor_id
    join public.organization_memberships membership
      on membership.org_id = actor.org_id and membership.actor_id = actor.id
    where domain.domain = lower(btrim(requested_domain))
      and domain.status = 'verified' and domain.mail_enabled and domain.aliases_enabled
      and alias.enabled and alias.disabled_at is null and alias.receive_enabled
      and lower(alias.email) = lower(btrim(requested_address))
      and actor.type = 'user' and actor.disabled_at is null
      and membership.status = 'active' and membership.guest_type = 'member'
    union
    select member.actor_id
    from public.admin_domains domain
    join public.admin_groups group_record on group_record.org_id = domain.org_id
    join public.admin_group_members member
      on member.org_id = group_record.org_id and member.group_id = group_record.id
    join public.actors actor on actor.org_id = member.org_id and actor.id = member.actor_id
    join public.organization_memberships membership
      on membership.org_id = actor.org_id and membership.actor_id = actor.id
    where domain.domain = lower(btrim(requested_domain))
      and domain.status = 'verified' and domain.mail_enabled and domain.aliases_enabled
      and group_record.kind = 'mailing_list'
      and lower(group_record.email) = lower(btrim(requested_address))
      and actor.type = 'user' and actor.disabled_at is null
      and membership.status = 'active' and membership.guest_type = 'member'
    union
    select actor.id
    from public.mail_inbound_routing_rules rule
    join public.actors actor
      on actor.org_id = rule.org_id and actor.id = (rule.action->>'aliasActorId')::uuid
    join public.organization_memberships membership
      on membership.org_id = actor.org_id and membership.actor_id = actor.id
    join public.admin_domains domain
      on domain.org_id = rule.org_id and domain.domain = lower(btrim(requested_domain))
    where rule.is_enabled and rule.action_kind = 'alias'
      and lower(btrim(rule.match->>'recipientPattern')) = lower(btrim(requested_address))
      and domain.status = 'verified' and domain.mail_enabled and domain.aliases_enabled
      and actor.type = 'user' and actor.disabled_at is null
      and membership.status = 'active' and membership.guest_type = 'member'
  ) candidate;

  if recipient_count > max_recipient_count then
    raise program_limit_exceeded using message = 'mail recipient expansion limit exceeded';
  end if;

  return query
  with candidates as (
    select resolved.org_id, resolved.actor_id, resolved.address
    from (
      select actor.org_id, actor.id as actor_id, lower(actor.email) as address
      from public.admin_domains domain
      left join public.admin_domains target on target.id = domain.alias_target_domain_id
      join public.actors actor on actor.org_id = domain.org_id
      join public.organization_memberships membership
        on membership.org_id = actor.org_id and membership.actor_id = actor.id
      join public.orgs org on org.id = domain.org_id
      where domain.domain = lower(btrim(requested_domain))
        and domain.domain = split_part(lower(btrim(requested_address)), '@', 2)
        and domain.status = 'verified' and domain.mail_enabled and domain.verified_at is not null
        and org.status = 'active' and org.suspended_at is null
        and org.soft_deleted_at is null and org.hard_deleted_at is null
        and (domain.identity_mode = 'secondary'
          or (target.status = 'verified' and target.identity_enabled and target.identity_mode = 'secondary'))
        and actor.type = 'user' and actor.disabled_at is null
        and membership.status = 'active' and membership.guest_type = 'member'
        and lower(actor.email) = split_part(lower(btrim(requested_address)), '@', 1) || '@' ||
          case domain.identity_mode when 'alias' then target.domain else domain.domain end
      union
      select alias.org_id, alias.actor_id, lower(alias.email)
      from public.admin_domains domain
      join public.mail_aliases alias on alias.org_id = domain.org_id
      join public.actors actor on actor.org_id = alias.org_id and actor.id = alias.actor_id
      join public.organization_memberships membership
        on membership.org_id = actor.org_id and membership.actor_id = actor.id
      join public.orgs org on org.id = domain.org_id
      where domain.domain = lower(btrim(requested_domain))
        and domain.status = 'verified' and domain.mail_enabled and domain.aliases_enabled
        and org.status = 'active' and org.suspended_at is null
        and org.soft_deleted_at is null and org.hard_deleted_at is null
        and alias.enabled and alias.disabled_at is null and alias.receive_enabled
        and lower(alias.email) = lower(btrim(requested_address))
        and actor.type = 'user' and actor.disabled_at is null
        and membership.status = 'active' and membership.guest_type = 'member'
      union
      select member.org_id, member.actor_id, lower(actor.email)
      from public.admin_domains domain
      join public.admin_groups group_record on group_record.org_id = domain.org_id
      join public.admin_group_members member
        on member.org_id = group_record.org_id and member.group_id = group_record.id
      join public.actors actor on actor.org_id = member.org_id and actor.id = member.actor_id
      join public.organization_memberships membership
        on membership.org_id = actor.org_id and membership.actor_id = actor.id
      join public.orgs org on org.id = domain.org_id
      where domain.domain = lower(btrim(requested_domain))
        and domain.status = 'verified' and domain.mail_enabled and domain.aliases_enabled
        and org.status = 'active' and org.suspended_at is null
        and org.soft_deleted_at is null and org.hard_deleted_at is null
        and group_record.kind = 'mailing_list'
        and lower(group_record.email) = lower(btrim(requested_address))
        and actor.type = 'user' and actor.disabled_at is null
        and membership.status = 'active' and membership.guest_type = 'member'
      union
      select actor.org_id, actor.id, lower(actor.email)
      from public.mail_inbound_routing_rules rule
      join public.actors actor
        on actor.org_id = rule.org_id and actor.id = (rule.action->>'aliasActorId')::uuid
      join public.organization_memberships membership
        on membership.org_id = actor.org_id and membership.actor_id = actor.id
      join public.admin_domains domain
        on domain.org_id = rule.org_id and domain.domain = lower(btrim(requested_domain))
      join public.orgs org on org.id = rule.org_id
      where rule.is_enabled and rule.action_kind = 'alias'
        and lower(btrim(rule.match->>'recipientPattern')) = lower(btrim(requested_address))
        and domain.status = 'verified' and domain.mail_enabled and domain.aliases_enabled
        and org.status = 'active' and org.suspended_at is null
        and org.soft_deleted_at is null and org.hard_deleted_at is null
        and actor.type = 'user' and actor.disabled_at is null
        and membership.status = 'active' and membership.guest_type = 'member'
    ) resolved
  ), usage as (
    select candidate.org_id, coalesce(sum(stored.byte_size), 0)::bigint as bytes
    from (select distinct source.org_id from candidates source) candidate
    left join lateral (
      select distinct on (item.storage_key) item.storage_key, item.byte_size
      from (
        select object.storage_key, object.byte_size, 0 as rank
        from public.objects object
        where object.org_id = candidate.org_id
          and object.kind in ('file', 'recording', 'mail_attachment')
          and object.deleted_at is null and coalesce(object.metadata->>'status', 'ready') = 'ready'
        union all
        select version.storage_key, version.byte_size, 1
        from public.drive_versions version
        join public.objects object on object.org_id = version.org_id and object.id = version.object_id
        where version.org_id = candidate.org_id and object.kind in ('file', 'recording')
          and object.deleted_at is null and coalesce(object.metadata->>'status', 'ready') = 'ready'
      ) item order by item.storage_key, item.rank
    ) stored on true
    group by candidate.org_id
  )
  select distinct candidate.org_id, candidate.actor_id, candidate.address,
    usage.bytes >= coalesce(
      nullif(org.quotas->>'storage_bytes_limit', '')::bigint,
      nullif(plan.quotas_default->>'storage_bytes_limit', '')::bigint,
      5000000000::bigint
    ) as quota_exceeded
  from candidates candidate
  join public.orgs org on org.id = candidate.org_id
  left join public.plans plan on plan.id = org.plan_id
  join usage on usage.org_id = candidate.org_id
  order by candidate.org_id, candidate.actor_id
  limit max_recipient_count;
end
$$;

alter function helix_resolve_inbound_mailboxes(text, text, integer)
  owner to helix_migration_owner;
revoke all on function helix_resolve_inbound_mailboxes(text, text, integer) from public;
grant execute on function helix_resolve_inbound_mailboxes(text, text, integer) to helix_app;

create or replace function helix_resolve_inbound_mailbox(
  requested_address text,
  requested_domain text
)
returns table (org_id uuid, actor_id uuid, address text, quota_exceeded boolean)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with resolved as materialized (
    select * from public.helix_resolve_inbound_mailboxes(
      requested_address, requested_domain, 100
    )
  )
  select resolved.org_id, resolved.actor_id, resolved.address, resolved.quota_exceeded
  from resolved
  where (select count(*) from resolved) = 1
$$;

alter function helix_resolve_inbound_mailbox(text, text) owner to helix_migration_owner;
revoke all on function helix_resolve_inbound_mailbox(text, text) from public;
grant execute on function helix_resolve_inbound_mailbox(text, text) to helix_app;

alter function helix_mail_address_is_local(uuid, text) owner to helix_migration_owner;
alter function helix_external_mail_forward_allowed(uuid, text) owner to helix_migration_owner;
alter function helix_validate_alias_address() owner to helix_migration_owner;
alter function helix_validate_mailbox_permission() owner to helix_migration_owner;
alter function helix_validate_mail_routing_rule() owner to helix_migration_owner;
alter function helix_audit_mail_address_change() owner to helix_migration_owner;
revoke all on function helix_mail_address_is_local(uuid, text) from public;
revoke all on function helix_external_mail_forward_allowed(uuid, text) from public;
revoke all on function helix_validate_mail_routing_rule() from public;
revoke all on function helix_audit_mail_address_change() from public;
