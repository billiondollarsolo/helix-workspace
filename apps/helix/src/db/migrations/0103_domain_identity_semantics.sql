-- Multi-domain identity/address semantics:
--   secondary = an independent user namespace;
--   alias     = local-part preserving alias of one secondary namespace.

create or replace function helix_canonical_login_email(tenant_id uuid, login_email text)
returns text
language sql
stable
as $$
  select case
    when exists (
      select 1 from admin_domains claimed
      where claimed.org_id = tenant_id
        and claimed.domain = split_part(lower(btrim(login_email)), '@', 2)
        and claimed.status <> 'released'
    ) then (
      select split_part(lower(btrim(login_email)), '@', 1) || '@' ||
        case domain.identity_mode
          when 'alias' then target.domain
          else domain.domain
        end
      from admin_domains domain
      left join admin_domains target on target.id = domain.alias_target_domain_id
      where domain.org_id = tenant_id
        and domain.domain = split_part(lower(btrim(login_email)), '@', 2)
        and domain.status = 'verified'
        and domain.identity_enabled
        and (
          domain.identity_mode = 'secondary'
          or (target.status = 'verified' and target.identity_enabled and target.identity_mode = 'secondary')
        )
      limit 1
    )
    else lower(btrim(login_email))
  end
$$;

-- This is the sole pre-auth cross-tenant lookup for email-domain discovery.
create or replace function helix_discover_domain_identity(login_email text)
returns table (
  org_id uuid,
  org_slug text,
  canonical_email text,
  protocol text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    domain.org_id,
    org.slug,
    split_part(lower(btrim(login_email)), '@', 1) || '@' ||
      case domain.identity_mode when 'alias' then target.domain else domain.domain end,
    case when domain.federation_enabled then idp.protocol else null end
  from public.admin_domains domain
  join public.orgs org on org.id = domain.org_id
  left join public.admin_domains target on target.id = domain.alias_target_domain_id
  left join lateral (
    select config.protocol
    from public.tenant_idp_configs config
    where config.org_id = domain.org_id and config.enabled and config.is_primary
    limit 1
  ) idp on true
  where domain.domain = split_part(lower(btrim(login_email)), '@', 2)
    and domain.status = 'verified'
    and domain.identity_enabled
    and (
      domain.identity_mode = 'secondary'
      or (target.status = 'verified' and target.identity_enabled and target.identity_mode = 'secondary')
    )
    and org.status = 'active'
    and org.suspended_at is null
    and org.soft_deleted_at is null
    and org.hard_deleted_at is null
  limit 1
$$;

alter function helix_discover_domain_identity(text) owner to helix_migration_owner;
revoke all on function helix_discover_domain_identity(text) from public;
grant execute on function helix_discover_domain_identity(text) to helix_app;

create or replace function helix_set_domain_capabilities(
  tenant_id uuid,
  target_domain_id uuid,
  next_identity_enabled boolean,
  next_mail_enabled boolean,
  next_aliases_enabled boolean,
  next_custom_host_enabled boolean,
  next_federation_enabled boolean,
  next_provider_id uuid,
  next_identity_mode text,
  next_alias_target_domain_id uuid,
  actor_id uuid
)
returns admin_domains
language plpgsql
as $$
declare
  target admin_domains%rowtype;
  becomes_primary boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('domain-primary:' || tenant_id::text, 0));
  select * into target from admin_domains
  where org_id = tenant_id and id = target_domain_id
  for update;
  if not found then return null; end if;
  if target.status <> 'verified' then
    raise exception 'domain_capabilities_require_verification' using errcode = 'P0001';
  end if;
  if target.is_primary and (not next_identity_enabled or next_identity_mode <> 'secondary') then
    raise exception 'domain_primary_dependency' using errcode = 'P0001';
  end if;
  if next_identity_mode not in ('secondary', 'alias')
     or (next_identity_mode = 'secondary' and next_alias_target_domain_id is not null)
     or (next_identity_mode = 'alias' and (
       next_alias_target_domain_id is null or not next_identity_enabled or not next_aliases_enabled
     ))
     or (next_custom_host_enabled and not next_identity_enabled)
     or (next_federation_enabled and not next_identity_enabled)
     or (next_aliases_enabled and not next_identity_enabled and not next_mail_enabled)
     or (next_provider_id is not null and not next_mail_enabled) then
    raise exception 'domain_capability_combination_invalid' using errcode = 'P0001';
  end if;
  if (not next_identity_enabled or next_identity_mode <> 'secondary') and exists (
    select 1 from actors actor
    join organization_memberships membership
      on membership.actor_id = actor.id and membership.org_id = actor.org_id
    where actor.org_id = tenant_id and actor.type = 'user' and actor.disabled_at is null
      and membership.status = 'active' and membership.guest_type = 'member'
      and lower(split_part(actor.email, '@', 2)) = target.domain
  ) then
    raise exception 'domain_identity_has_dependencies' using errcode = 'P0001';
  end if;
  if (not next_identity_enabled or next_identity_mode <> 'secondary') and exists (
    select 1 from admin_domains alias_domain
    where alias_domain.org_id = tenant_id
      and alias_domain.status = 'verified'
      and alias_domain.identity_mode = 'alias'
      and alias_domain.alias_target_domain_id = target.id
  ) then
    raise exception 'domain_alias_target_has_dependencies' using errcode = 'P0001';
  end if;
  if (not next_mail_enabled or not next_aliases_enabled) and exists (
    select 1 from mail_aliases alias
    where alias.org_id = tenant_id and alias.enabled and alias.disabled_at is null
      and lower(split_part(alias.email, '@', 2)) = target.domain
    union all
    select 1 from admin_groups group_record
    where group_record.org_id = tenant_id and group_record.email is not null
      and lower(split_part(group_record.email, '@', 2)) = target.domain
  ) then
    raise exception 'domain_address_has_dependencies' using errcode = 'P0001';
  end if;
  if not next_federation_enabled and exists (
    select 1 from tenant_idp_configs idp
    where idp.org_id = tenant_id and idp.enabled
  ) and not exists (
    select 1 from admin_domains sibling
    where sibling.org_id = tenant_id and sibling.id <> target.id
      and sibling.status = 'verified' and sibling.federation_enabled
  ) then
    raise exception 'domain_federation_has_dependencies' using errcode = 'P0001';
  end if;

  becomes_primary := next_identity_enabled
    and next_identity_mode = 'secondary'
    and not target.is_primary
    and not exists (
      select 1 from admin_domains
      where org_id = tenant_id and is_primary
    );

  update admin_domains
  set identity_enabled = next_identity_enabled,
      mail_enabled = next_mail_enabled,
      aliases_enabled = next_aliases_enabled,
      custom_host_enabled = next_custom_host_enabled,
      federation_enabled = next_federation_enabled,
      provider_id = next_provider_id,
      identity_mode = next_identity_mode,
      alias_target_domain_id = next_alias_target_domain_id,
      is_primary = target.is_primary or becomes_primary,
      updated_at = now()
  where id = target.id
  returning * into target;
  if becomes_primary then
    insert into admin_domain_primary_transitions (org_id, to_domain_id, changed_by)
    values (tenant_id, target.id, actor_id);
  end if;
  return target;
end
$$;

create or replace function helix_assert_directory_address(
  tenant_id uuid,
  address text,
  address_kind text,
  record_id uuid
)
returns void
language plpgsql
as $$
declare
  normalized text := lower(btrim(address));
  canonical text;
  address_domain text := split_part(normalized, '@', 2);
begin
  if normalized !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    raise exception 'invalid_directory_address' using errcode = '23514';
  end if;
  canonical := coalesce(helix_canonical_login_email(tenant_id, normalized), normalized);
  perform pg_advisory_xact_lock(
    hashtextextended('directory-address:' || tenant_id::text || ':' || canonical, 0)
  );

  -- An unmanaged address can bootstrap a workspace, but a name already claimed
  -- by this workspace always follows its lifecycle and capability state.
  if (
    exists (
      select 1 from admin_domains owned
      where owned.org_id = tenant_id and owned.status = 'verified' and owned.identity_enabled
    ) or exists (
      select 1 from admin_domains claimed
      where claimed.org_id = tenant_id and claimed.domain = address_domain
        and claimed.status <> 'released'
    )
  ) and not exists (
    select 1 from admin_domains domain
    where domain.org_id = tenant_id
      and domain.domain = address_domain
      and domain.status = 'verified'
      and case address_kind
        when 'member' then domain.identity_enabled and domain.identity_mode = 'secondary'
        else domain.aliases_enabled and domain.mail_enabled
      end
  ) then
    raise exception 'directory_address_domain_ineligible' using errcode = '23514';
  end if;

  if exists (
    select 1 from actors actor
    where actor.org_id = tenant_id and actor.type = 'user' and actor.disabled_at is null
      and (address_kind <> 'member' or actor.id <> record_id)
      and helix_canonical_login_email(tenant_id, actor.email) = canonical
    union all
    select 1 from mail_aliases alias
    where alias.org_id = tenant_id and alias.enabled and alias.disabled_at is null
      and (address_kind <> 'alias' or alias.id <> record_id)
      and helix_canonical_login_email(tenant_id, alias.email) = canonical
    union all
    select 1 from admin_groups group_record
    where group_record.org_id = tenant_id and group_record.email is not null
      and (address_kind <> 'group' or group_record.id <> record_id)
      and helix_canonical_login_email(tenant_id, group_record.email) = canonical
  ) then
    raise exception 'directory_address_collision' using errcode = '23505';
  end if;
end
$$;

create or replace function helix_validate_member_address()
returns trigger
language plpgsql
as $$
declare
  member_email text;
begin
  if new.status = 'active' and new.guest_type = 'member' then
    select email into member_email from actors
    where id = new.actor_id and org_id = new.org_id and disabled_at is null;
    if member_email is not null then
      perform helix_assert_directory_address(new.org_id, member_email, 'member', new.actor_id);
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists organization_memberships_address_guard on organization_memberships;
create constraint trigger organization_memberships_address_guard
after insert or update of org_id, status, guest_type, actor_id on organization_memberships
deferrable initially deferred
for each row execute function helix_validate_member_address();

create or replace function helix_validate_actor_address()
returns trigger
language plpgsql
as $$
begin
  if new.type = 'user' and new.disabled_at is null and new.email is not null and exists (
    select 1 from organization_memberships membership
    where membership.actor_id = new.id and membership.org_id = new.org_id
      and membership.status = 'active' and membership.guest_type = 'member'
  ) then
    perform helix_assert_directory_address(new.org_id, new.email, 'member', new.id);
  end if;
  return new;
end
$$;

drop trigger if exists actors_address_guard on actors;
create constraint trigger actors_address_guard
after insert or update of org_id, type, email, disabled_at on actors
deferrable initially deferred
for each row execute function helix_validate_actor_address();

create or replace function helix_validate_alias_address()
returns trigger
language plpgsql
as $$
begin
  if new.enabled and new.disabled_at is null then
    perform helix_assert_directory_address(new.org_id, new.email, 'alias', new.id);
  end if;
  return new;
end
$$;

drop trigger if exists mail_aliases_address_guard on mail_aliases;
create constraint trigger mail_aliases_address_guard
after insert or update of org_id, email, enabled, disabled_at on mail_aliases
deferrable initially deferred
for each row execute function helix_validate_alias_address();

create or replace function helix_validate_group_address()
returns trigger
language plpgsql
as $$
begin
  if new.email is not null then
    perform helix_assert_directory_address(new.org_id, new.email, 'group', new.id);
  end if;
  return new;
end
$$;

drop trigger if exists admin_groups_address_guard on admin_groups;
create constraint trigger admin_groups_address_guard
after insert or update of org_id, email on admin_groups
deferrable initially deferred
for each row execute function helix_validate_group_address();

create unique index admin_groups_org_email_idx
  on admin_groups (org_id, lower(email)) where email is not null;

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
      domain.org_id,
      split_part(lower(btrim(requested_address)), '@', 1) || '@' ||
        case domain.identity_mode when 'alias' then target.domain else domain.domain end
        as canonical_address,
      case
        when org.quotas ? 'storage_bytes_limit'
          then nullif(org.quotas ->> 'storage_bytes_limit', '')::bigint
        when plan.quotas_default ? 'storage_bytes_limit'
          then nullif(plan.quotas_default ->> 'storage_bytes_limit', '')::bigint
        else 5000000000::bigint
      end as storage_bytes_limit,
      domain.identity_enabled,
      domain.aliases_enabled
    from public.admin_domains domain
    left join public.admin_domains target on target.id = domain.alias_target_domain_id
    join public.orgs org on org.id = domain.org_id
    left join public.plans plan on plan.id = org.plan_id
    where domain.domain = lower(btrim(requested_domain))
      and lower(btrim(requested_domain)) = split_part(lower(btrim(requested_address)), '@', 2)
      and lower(btrim(requested_address)) ~ '^[^@[:space:]]+@[^@[:space:]]+$'
      and domain.status = 'verified'
      and domain.mail_enabled
      and domain.verified_at is not null
      and (
        domain.identity_mode = 'secondary'
        or (target.status = 'verified' and target.identity_enabled
            and target.identity_mode = 'secondary')
      )
      and org.status = 'active'
      and org.suspended_at is null
      and org.soft_deleted_at is null
      and org.hard_deleted_at is null
  ), candidates as (
    select actor.org_id, actor.id as actor_id, lower(btrim(requested_address)) as address,
           domain.storage_bytes_limit
    from verified_domains domain
    join public.actors actor on actor.org_id = domain.org_id
    join public.organization_memberships membership
      on membership.actor_id = actor.id and membership.org_id = actor.org_id
    where actor.type = 'user'
      and actor.disabled_at is null
      and membership.status = 'active'
      and membership.guest_type = 'member'
      and domain.identity_enabled
      and lower(actor.email) = domain.canonical_address
    union
    select alias.org_id, alias.actor_id, alias.email as address, domain.storage_bytes_limit
    from verified_domains domain
    join public.mail_aliases alias on alias.org_id = domain.org_id
    join public.actors actor on actor.id = alias.actor_id and actor.org_id = alias.org_id
    join public.organization_memberships membership
      on membership.actor_id = actor.id and membership.org_id = actor.org_id
    where alias.enabled
      and alias.disabled_at is null
      and actor.type = 'user'
      and actor.disabled_at is null
      and membership.status = 'active'
      and membership.guest_type = 'member'
      and domain.aliases_enabled
      and lower(alias.email) = lower(btrim(requested_address))
  )
  select distinct
    candidates.org_id,
    candidates.actor_id,
    candidates.address,
    coalesce(
      (
        select coalesce(sum(stored_object.byte_size), 0)::bigint
        from (
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

alter function helix_resolve_inbound_mailbox(text, text) owner to helix_migration_owner;
revoke all on function helix_resolve_inbound_mailbox(text, text) from public;
grant execute on function helix_resolve_inbound_mailbox(text, text) to helix_app;
