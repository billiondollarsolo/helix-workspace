-- Serialized, reversible primary-domain transitions and release cooldowns.

create table admin_domain_primary_transitions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  from_domain_id uuid,
  to_domain_id uuid,
  changed_by uuid,
  changed_at timestamptz not null default now(),
  rollback_until timestamptz not null default (now() + interval '24 hours'),
  rolled_back_at timestamptz,
  rolled_back_by uuid,
  constraint admin_domain_primary_transition_direction
    check (from_domain_id is distinct from to_domain_id),
  constraint admin_domain_primary_transition_rollback
    check ((rolled_back_at is null) = (rolled_back_by is null)),
  constraint admin_domain_primary_transitions_from_org_fk
    foreign key (org_id, from_domain_id)
    references admin_domains (org_id, id) on delete restrict,
  constraint admin_domain_primary_transitions_to_org_fk
    foreign key (org_id, to_domain_id)
    references admin_domains (org_id, id) on delete restrict,
  constraint admin_domain_primary_transitions_changed_by_org_fk
    foreign key (org_id, changed_by)
    references actors (org_id, id) on delete set null (changed_by),
  constraint admin_domain_primary_transitions_rolled_back_by_org_fk
    foreign key (org_id, rolled_back_by)
    references actors (org_id, id) on delete set null (rolled_back_by)
);

create index admin_domain_primary_transitions_org_time_idx
  on admin_domain_primary_transitions (org_id, changed_at desc, id desc);

alter table admin_domain_primary_transitions enable row level security;
alter table admin_domain_primary_transitions force row level security;
create policy helix_tenant_isolation on admin_domain_primary_transitions
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

-- A released claim is reserved for its previous owner during the cooldown.
-- The definer trigger only answers that one cross-tenant collision question.
create or replace function helix_guard_domain_acquisition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status <> 'released' and exists (
    select 1 from public.admin_domains released
    where released.id <> new.id
      and released.domain = new.domain
      and released.status = 'released'
      and released.org_id <> new.org_id
      and released.claimable_after > now()
  ) then
    raise exception 'domain_acquisition_cooldown' using errcode = 'P0001';
  end if;
  return new;
end
$$;

alter function helix_guard_domain_acquisition() owner to helix_migration_owner;
revoke all on function helix_guard_domain_acquisition() from public;

drop trigger if exists admin_domains_acquisition_guard on admin_domains;
create trigger admin_domains_acquisition_guard
before insert or update of domain, org_id, status on admin_domains
for each row execute function helix_guard_domain_acquisition();

create or replace function helix_assert_one_primary_domain()
returns trigger
language plpgsql
as $$
declare
  tenant_id uuid;
  tenant_ids uuid[];
  eligible_count integer;
  primary_count integer;
begin
  tenant_ids := case tg_op
    when 'INSERT' then array[new.org_id]
    when 'DELETE' then array[old.org_id]
    else array[new.org_id, old.org_id]
  end;
  foreach tenant_id in array tenant_ids loop
    select count(*), count(*) filter (where is_primary)
    into eligible_count, primary_count
    from admin_domains
    where org_id = tenant_id
      and status = 'verified'
      and identity_enabled
      and identity_mode = 'secondary';

    if eligible_count > 0 and primary_count <> 1 then
      raise exception 'workspace must have exactly one eligible primary domain'
        using errcode = '23514';
    end if;
  end loop;
  return null;
end
$$;

drop trigger if exists admin_domains_exactly_one_primary on admin_domains;
create constraint trigger admin_domains_exactly_one_primary
after insert or update or delete on admin_domains
deferrable initially deferred
for each row execute function helix_assert_one_primary_domain();

create or replace function helix_set_primary_domain(
  tenant_id uuid,
  target_domain_id uuid,
  actor_id uuid
)
returns admin_domains
language plpgsql
as $$
declare
  current_primary admin_domains%rowtype;
  target admin_domains%rowtype;
  changed admin_domains%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('domain-primary:' || tenant_id::text, 0));

  select * into target
  from admin_domains
  where org_id = tenant_id and id = target_domain_id
  for update;

  if not found or target.status <> 'verified' or not target.identity_enabled
     or target.identity_mode <> 'secondary' then
    raise exception 'domain_primary_ineligible' using errcode = 'P0001';
  end if;

  select * into current_primary
  from admin_domains
  where org_id = tenant_id and is_primary
  for update;

  if found and current_primary.id = target.id then
    return target;
  end if;

  if exists (
    select 1 from admin_domain_primary_transitions transition
    where transition.org_id = tenant_id
      and transition.from_domain_id is not null
      and transition.changed_at > now() - interval '1 hour'
  ) then
    raise exception 'domain_primary_cooldown' using errcode = 'P0001';
  end if;

  -- Promotion cannot silently remove a capability supplied by the old primary.
  if current_primary.id is not null and (
    (current_primary.mail_enabled and not target.mail_enabled)
    or (current_primary.aliases_enabled and not target.aliases_enabled)
    or (current_primary.custom_host_enabled and not target.custom_host_enabled)
    or (current_primary.federation_enabled and not target.federation_enabled)
  ) then
    raise exception 'domain_primary_dependency' using errcode = 'P0001';
  end if;

  update admin_domain_primary_transitions
  set rollback_until = least(rollback_until, now())
  where org_id = tenant_id and rolled_back_at is null and from_domain_id is not null;

  update admin_domains set is_primary = false, updated_at = now()
  where org_id = tenant_id and is_primary;
  update admin_domains set is_primary = true, updated_at = now()
  where org_id = tenant_id and id = target.id
  returning * into changed;

  insert into admin_domain_primary_transitions (
    org_id, from_domain_id, to_domain_id, changed_by
  ) values (tenant_id, current_primary.id, target.id, actor_id);

  return changed;
end
$$;

create or replace function helix_rollback_primary_domain(
  tenant_id uuid,
  transition_id uuid,
  actor_id uuid
)
returns admin_domains
language plpgsql
as $$
declare
  transition admin_domain_primary_transitions%rowtype;
  restored admin_domains%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('domain-primary:' || tenant_id::text, 0));

  select * into transition
  from admin_domain_primary_transitions candidate
  where candidate.org_id = tenant_id
    and candidate.id = transition_id
    and candidate.rolled_back_at is null
  for update;

  if not found or transition.from_domain_id is null
     or transition.rollback_until <= now() then
    raise exception 'domain_primary_rollback_unavailable' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from admin_domains current
    where current.org_id = tenant_id
      and current.id = transition.to_domain_id
      and current.is_primary
  ) then
    raise exception 'domain_primary_rollback_stale' using errcode = 'P0001';
  end if;

  select * into restored
  from admin_domains prior
  where prior.org_id = tenant_id
    and prior.id = transition.from_domain_id
    and prior.status = 'verified'
    and prior.identity_enabled
    and prior.identity_mode = 'secondary'
  for update;
  if not found then
    raise exception 'domain_primary_rollback_ineligible' using errcode = 'P0001';
  end if;
  if (transition.to_domain_id is not null) and exists (
    select 1 from admin_domains current
    where current.org_id = tenant_id and current.id = transition.to_domain_id
      and ((current.mail_enabled and not restored.mail_enabled)
        or (current.aliases_enabled and not restored.aliases_enabled)
        or (current.custom_host_enabled and not restored.custom_host_enabled)
        or (current.federation_enabled and not restored.federation_enabled))
  ) then
    raise exception 'domain_primary_dependency' using errcode = 'P0001';
  end if;

  update admin_domains set is_primary = false, updated_at = now()
  where org_id = tenant_id and is_primary;
  update admin_domains set is_primary = true, updated_at = now()
  where org_id = tenant_id and id = restored.id
  returning * into restored;
  update admin_domain_primary_transitions
  set rolled_back_at = now(), rolled_back_by = actor_id
  where id = transition.id;

  return restored;
end
$$;

create or replace function helix_release_domain(
  tenant_id uuid,
  target_domain_id uuid
)
returns admin_domains
language plpgsql
as $$
declare
  target admin_domains%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('domain-primary:' || tenant_id::text, 0));
  select * into target from admin_domains
  where org_id = tenant_id and id = target_domain_id
  for update;
  if not found then return null; end if;
  if target.status = 'released' then return target; end if;
  if target.is_primary then
    raise exception 'domain_release_primary' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from actors actor
    where actor.org_id = tenant_id and actor.type = 'user' and actor.disabled_at is null
      and lower(split_part(actor.email, '@', 2)) = target.domain
    union all
    select 1 from mail_aliases alias
    where alias.org_id = tenant_id and alias.enabled and alias.disabled_at is null
      and lower(split_part(alias.email, '@', 2)) = target.domain
    union all
    select 1 from admin_groups group_record
    where group_record.org_id = tenant_id and group_record.email is not null
      and lower(split_part(group_record.email, '@', 2)) = target.domain
    union all
    select 1 from admin_domains alias_domain
    where alias_domain.org_id = tenant_id
      and alias_domain.status <> 'released'
      and alias_domain.alias_target_domain_id = target.id
    union all
    select 1 from tenant_idp_configs idp
    where idp.org_id = tenant_id and idp.enabled and target.federation_enabled
      and not exists (
        select 1 from admin_domains sibling
        where sibling.org_id = tenant_id and sibling.id <> target.id
          and sibling.status = 'verified' and sibling.federation_enabled
      )
  ) then
    raise exception 'domain_release_has_dependencies' using errcode = 'P0001';
  end if;

  update admin_domains
  set status = 'released', verified_at = null, is_primary = false,
      identity_enabled = false, mail_enabled = false, aliases_enabled = false,
      custom_host_enabled = false, federation_enabled = false,
      provider_id = null, quarantined_at = null,
      released_at = now(), claimable_after = now() + interval '7 days', updated_at = now()
  where id = target.id
  returning * into target;
  return target;
end
$$;

create or replace function helix_record_domain_verification(
  tenant_id uuid,
  target_domain_id uuid,
  verification_succeeded boolean,
  actor_id uuid
)
returns admin_domains
language plpgsql
as $$
declare
  target admin_domains%rowtype;
  replacement admin_domains%rowtype;
  was_primary boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('domain-primary:' || tenant_id::text, 0));
  select * into target from admin_domains
  where org_id = tenant_id and id = target_domain_id and status <> 'released'
  for update;
  if not found then return null; end if;
  was_primary := target.is_primary;

  if verification_succeeded then
    if target.status = 'verified' then
      update admin_domains
      set verified_at = now(), verification_attempts = verification_attempts + 1,
          verification_last_attempt_at = now(), updated_at = now()
      where id = target.id
      returning * into target;
    else
      update admin_domains
      set status = 'verified', verified_at = now(), quarantined_at = null, released_at = null,
          claimable_after = null, is_primary = false,
          identity_enabled = false, mail_enabled = false, aliases_enabled = false,
          custom_host_enabled = false, federation_enabled = false, provider_id = null,
          identity_mode = 'secondary', alias_target_domain_id = null,
          verification_attempts = verification_attempts + 1,
          verification_last_attempt_at = now(), updated_at = now()
      where id = target.id
      returning * into target;
    end if;
    return target;
  end if;

  if target.status = 'verified' then
    select * into replacement
    from admin_domains candidate
    where candidate.org_id = tenant_id and candidate.id <> target.id
      and candidate.status = 'verified' and candidate.identity_enabled
      and candidate.identity_mode = 'secondary'
    order by candidate.created_at, candidate.id
    limit 1
    for update;

    update admin_domains
    set status = 'quarantined', is_primary = false,
        identity_enabled = false, mail_enabled = false, aliases_enabled = false,
        custom_host_enabled = false, federation_enabled = false,
        provider_id = null, quarantined_at = now(), released_at = null,
        verification_attempts = verification_attempts + 1,
        verification_last_attempt_at = now(), updated_at = now()
    where id = target.id
    returning * into target;
    update admin_domains alias_domain
    set status = 'quarantined', is_primary = false,
        identity_enabled = false, mail_enabled = false, aliases_enabled = false,
        custom_host_enabled = false, federation_enabled = false,
        provider_id = null, quarantined_at = now(), released_at = null, updated_at = now()
    where alias_domain.org_id = tenant_id
      and alias_domain.status = 'verified'
      and alias_domain.identity_mode = 'alias'
      and alias_domain.alias_target_domain_id = target.id;
    if replacement.id is not null and was_primary then
      update admin_domains set is_primary = true, updated_at = now()
      where id = replacement.id;
      insert into admin_domain_primary_transitions (
        org_id, from_domain_id, to_domain_id, changed_by, rollback_until
      ) values (tenant_id, target.id, replacement.id, actor_id, now());
    end if;
    return target;
  end if;

  update admin_domains
  set status = 'pending', verified_at = null, quarantined_at = null,
      identity_enabled = false, mail_enabled = false, aliases_enabled = false,
      custom_host_enabled = false, federation_enabled = false,
      verification_attempts = verification_attempts + 1,
      verification_last_attempt_at = now(), updated_at = now()
  where id = target.id
  returning * into target;

  return target;
end
$$;

create or replace function helix_quarantine_domain(
  tenant_id uuid,
  target_domain_id uuid,
  actor_id uuid
)
returns admin_domains
language plpgsql
as $$
declare
  target admin_domains%rowtype;
  replacement admin_domains%rowtype;
  was_primary boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('domain-primary:' || tenant_id::text, 0));
  select * into target from admin_domains
  where org_id = tenant_id and id = target_domain_id and status <> 'released'
  for update;
  if not found then return null; end if;
  was_primary := target.is_primary;

  if was_primary then
    select * into replacement
    from admin_domains candidate
    where candidate.org_id = tenant_id and candidate.id <> target.id
      and candidate.status = 'verified' and candidate.identity_enabled
      and candidate.identity_mode = 'secondary'
    order by candidate.created_at, candidate.id
    limit 1
    for update;
  end if;

  update admin_domains
  set status = 'quarantined', is_primary = false,
      identity_enabled = false, mail_enabled = false, aliases_enabled = false,
      custom_host_enabled = false, federation_enabled = false,
      provider_id = null, quarantined_at = now(), released_at = null, updated_at = now()
  where id = target.id
  returning * into target;

  update admin_domains alias_domain
  set status = 'quarantined', is_primary = false,
      identity_enabled = false, mail_enabled = false, aliases_enabled = false,
      custom_host_enabled = false, federation_enabled = false,
      provider_id = null, quarantined_at = now(), released_at = null, updated_at = now()
  where alias_domain.org_id = tenant_id
    and alias_domain.status = 'verified'
    and alias_domain.identity_mode = 'alias'
    and alias_domain.alias_target_domain_id = target.id;

  if replacement.id is not null then
    update admin_domains set is_primary = true, updated_at = now()
    where id = replacement.id;
  end if;
  if was_primary then
    insert into admin_domain_primary_transitions (
      org_id, from_domain_id, to_domain_id, changed_by, rollback_until
    ) values (tenant_id, target.id, replacement.id, actor_id, now());
  end if;
  return target;
end
$$;
