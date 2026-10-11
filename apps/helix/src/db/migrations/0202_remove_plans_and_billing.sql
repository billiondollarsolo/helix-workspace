-- Helix is free and open source with no plans, billing or plan limits.
-- Every org gets every feature and no quota unless an org admin sets one on
-- its own tenant (orgs.quotas). This migration removes the commercial plan
-- layer and the billing read model:
--   * storage limits come only from orgs.quotas; a missing or null limit is
--     unlimited (previously it fell back to the plan, then to 5 GB);
--   * the plans table, orgs.plan_id and its FK and index are dropped;
--   * the admin billing read-model tables are dropped.
-- Older migrations are left untouched; this one supersedes them.

create or replace function helix_storage_limit_bytes(input_org_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  result bigint;
  tenant_found boolean;
begin
  select true, nullif(org.quotas->>'storage_bytes_limit', '')::bigint
  into tenant_found, result
  from public.orgs org
  where org.id = input_org_id;
  if not coalesce(tenant_found, false) then
    raise no_data_found using message = 'unknown storage tenant';
  end if;
  return result;
end
$$;

-- Inbound mail marks a recipient over quota only when its org has an explicit
-- storage limit and usage has reached it. The body is otherwise unchanged
-- from the current definition; only the plan join and the 5 GB fallback go.
create or replace function public.helix_resolve_exact_inbound_mailboxes(
  requested_address text,
  requested_domain text,
  max_recipient_count integer default 100
)
returns table(org_id uuid, actor_id uuid, address text, quota_exceeded boolean)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
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
    coalesce(
      usage.bytes >= nullif(org.quotas->>'storage_bytes_limit', '')::bigint,
      false
    ) as quota_exceeded
  from candidates candidate
  join public.orgs org on org.id = candidate.org_id
  join usage on usage.org_id = candidate.org_id
  order by candidate.org_id, candidate.actor_id
  limit max_recipient_count;
end
$function$;

alter table orgs drop constraint if exists orgs_plan_id_fkey;
drop index if exists orgs_plan_id_idx;
alter table orgs drop column if exists plan_id;
drop table if exists plans;

drop table if exists admin_billing_invoices;
drop table if exists admin_billing_accounts;
