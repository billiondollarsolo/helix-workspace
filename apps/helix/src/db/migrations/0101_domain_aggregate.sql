-- One canonical, globally exclusive domain aggregate. Ownership, identity,
-- mail, alias, custom-host, and federation state all live on admin_domains.

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'admin_domains'
      and column_name = 'verification_status'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'admin_domains'
      and column_name = 'status'
  ) then
    alter table admin_domains rename column verification_status to status;
  end if;
end
$$;

alter table admin_domains
  drop constraint if exists admin_domains_verification_status_check,
  drop constraint if exists admin_domains_status_check,
  drop constraint if exists admin_domains_primary_verified_check;

update admin_domains set status = 'pending' where status = 'failed';

-- Normalize legacy rows before installing the stricter lifecycle constraints.
update admin_domains
set verified_at = case
      when status = 'verified' then coalesce(verified_at, updated_at, created_at, now())
      else null
    end,
    is_primary = is_primary and status = 'verified';

alter table admin_domains
  add column if not exists identity_enabled boolean not null default false,
  add column if not exists mail_enabled boolean not null default false,
  add column if not exists aliases_enabled boolean not null default false,
  add column if not exists custom_host_enabled boolean not null default false,
  add column if not exists federation_enabled boolean not null default false,
  add column if not exists provider_id uuid,
  add column if not exists identity_mode text not null default 'secondary',
  add column if not exists alias_target_domain_id uuid,
  add column if not exists quarantined_at timestamptz,
  add column if not exists released_at timestamptz,
  add column if not exists claimable_after timestamptz;

-- Refuse to guess ownership if an installation already contains contradictory
-- active claims. An operator must resolve that unsafe state before upgrading.
do $$
begin
  if exists (
    select lower(domain)
    from (
      select org_id, domain from admin_domains where status <> 'released'
      union all
      select org_id, domain from mail_sending_domains
    ) claims
    group by lower(domain)
    having count(distinct org_id) > 1
  ) then
    raise exception 'Conflicting cross-tenant domain claims must be resolved before migration 0101';
  end if;
end
$$;

-- Preserve a sending-only row if old data somehow predates its ownership row.
insert into admin_domains (
  org_id, domain, status, verified_at,
  verification_host, verification_value, verification_expires_at,
  created_by, created_at, updated_at
)
select
  sending.org_id,
  lower(btrim(sending.domain)),
  'pending',
  null,
  '_helix-verification.' || lower(btrim(sending.domain)),
  'migration-required',
  now(),
  sending.created_by,
  sending.created_at,
  sending.updated_at
from mail_sending_domains sending
where not exists (
  select 1 from admin_domains domain
  where domain.org_id = sending.org_id
    and lower(domain.domain) = lower(sending.domain)
);

-- Existing verified ownership keeps identity/custom-host behavior. Existing
-- sending-domain rows are the sole source of migrated mail capability/provider.
update admin_domains domain
set identity_enabled = domain.status = 'verified',
    aliases_enabled = domain.status = 'verified',
    custom_host_enabled = domain.status = 'verified',
    mail_enabled = domain.status = 'verified' and sending.id is not null,
    federation_enabled = domain.status = 'verified' and exists (
      select 1 from tenant_idp_configs idp
      where idp.org_id = domain.org_id and idp.enabled
    ),
    provider_id = case
      when domain.status = 'verified' and exists (
        select 1 from mail_outbound_providers provider
        where provider.id = sending.provider_id and provider.org_id = domain.org_id
      ) then sending.provider_id
      else null
    end,
    updated_at = greatest(domain.updated_at, coalesce(sending.updated_at, domain.updated_at))
from (
  select ownership.id as ownership_id, sending.id, sending.provider_id, sending.updated_at
  from admin_domains ownership
  left join mail_sending_domains sending
    on sending.org_id = ownership.org_id
   and lower(sending.domain) = lower(ownership.domain)
) sending
where sending.ownership_id = domain.id;

-- A verified identity namespace always has exactly one initial primary. Later
-- changes go through the serialized transition functions in migration 0102.
with ranked as (
  select id, row_number() over (
    partition by org_id order by is_primary desc, verified_at asc nulls last, created_at asc, id asc
  ) as position
  from admin_domains
  where status = 'verified' and identity_enabled and identity_mode = 'secondary'
)
update admin_domains domain
set is_primary = ranked.position = 1
from ranked
where domain.id = ranked.id;

-- Repoint DKIM keys before deleting the duplicate aggregate.
alter table mail_dkim_keys drop constraint if exists mail_dkim_keys_domain_id_fkey;

update mail_dkim_keys key
set domain_id = ownership.id
from mail_sending_domains sending
join admin_domains ownership
  on ownership.org_id = sending.org_id
 and lower(ownership.domain) = lower(sending.domain)
where key.org_id = sending.org_id
  and key.domain_id = sending.id;

do $$
begin
  if exists (
    select 1
    from mail_dkim_keys key
    left join admin_domains domain
      on domain.id = key.domain_id and domain.org_id = key.org_id
    where domain.id is null
  ) then
    raise exception 'A DKIM key has no canonical domain';
  end if;
end
$$;

drop table mail_sending_domains;

update admin_domains set domain = lower(btrim(domain));

drop index if exists admin_domains_domain_idx;
drop index if exists admin_domains_org_domain_idx;
create unique index admin_domains_active_domain_idx
  on admin_domains (lower(domain)) where status <> 'released';
create unique index admin_domains_org_id_idx on admin_domains (org_id, id);
create unique index mail_outbound_providers_org_id_idx on mail_outbound_providers (org_id, id);

alter table admin_domains
  add constraint admin_domains_status_check
    check (status in ('pending', 'verified', 'quarantined', 'released')),
  add constraint admin_domains_normalized_check
    check (domain = lower(btrim(domain))),
  add constraint admin_domains_verification_state_check
    check (
      (status = 'verified' and verified_at is not null and quarantined_at is null
        and released_at is null and claimable_after is null)
      or (status = 'pending' and verified_at is null and quarantined_at is null
        and released_at is null and claimable_after is null)
      or (status = 'quarantined' and quarantined_at is not null
        and released_at is null and claimable_after is null)
      or (status = 'released' and verified_at is null and quarantined_at is null
          and released_at is not null and claimable_after is not null)
    ),
  add constraint admin_domains_capability_state_check
    check (
      (status = 'verified'
        and (not custom_host_enabled or identity_enabled)
        and (not federation_enabled or identity_enabled)
        and (not aliases_enabled or identity_enabled or mail_enabled)
        and (provider_id is null or mail_enabled))
      or (status <> 'verified'
        and not (identity_enabled or mail_enabled or aliases_enabled
                 or custom_host_enabled or federation_enabled)
        and provider_id is null)
    ),
  add constraint admin_domains_identity_mode_check
    check (identity_mode in ('secondary', 'alias')),
  add constraint admin_domains_alias_shape_check
    check (
      (identity_mode = 'secondary' and alias_target_domain_id is null)
      or (identity_mode = 'alias' and alias_target_domain_id is not null
          and (status <> 'verified' or (identity_enabled and aliases_enabled)))
    ),
  add constraint admin_domains_primary_eligible_check
    check (not is_primary or (status = 'verified' and identity_enabled and identity_mode = 'secondary')),
  add constraint admin_domains_provider_org_fk
    foreign key (org_id, provider_id)
    references mail_outbound_providers (org_id, id) on delete set null (provider_id),
  add constraint admin_domains_alias_target_org_fk
    foreign key (org_id, alias_target_domain_id)
    references admin_domains (org_id, id) on delete restrict;

alter table admin_dns_records
  drop constraint if exists admin_dns_records_domain_id_fkey,
  add constraint admin_dns_records_domain_org_fk
    foreign key (org_id, domain_id)
    references admin_domains (org_id, id) on delete cascade;

alter table mail_dkim_keys
  add constraint mail_dkim_keys_domain_org_fk
    foreign key (org_id, domain_id)
    references admin_domains (org_id, id) on delete cascade;

-- Cross-tenant alias targets cannot be expressed by a plain self-FK.
create or replace function helix_validate_domain_alias_targets()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  tenant_id uuid := coalesce(new.org_id, old.org_id);
begin
  if exists (
    select 1
    from admin_domains source
    left join admin_domains target
      on target.id = source.alias_target_domain_id and target.org_id = source.org_id
    where source.org_id = tenant_id
      and source.status = 'verified'
      and source.identity_mode = 'alias'
      and (target.id is null or target.status <> 'verified'
           or not target.identity_enabled or target.identity_mode <> 'secondary')
  ) then
    raise exception 'Domain alias target must be a verified identity domain in the same workspace'
      using errcode = '23514';
  end if;
  return null;
end
$$;

alter function helix_validate_domain_alias_targets() owner to helix_migration_owner;
revoke all on function helix_validate_domain_alias_targets() from public;

drop trigger if exists admin_domains_alias_target_guard on admin_domains;
create constraint trigger admin_domains_alias_target_guard
after insert or update or delete on admin_domains
deferrable initially deferred
for each row execute function helix_validate_domain_alias_targets();

-- Custom-host discovery is restricted to its explicit capability.
create or replace function helix_verified_tenant_domain(hostname text)
returns setof public.admin_domains
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select domain.*
  from public.admin_domains domain
  where domain.domain = lower(btrim(hostname))
    and domain.status = 'verified'
    and domain.custom_host_enabled
  limit 1
$$;

alter function helix_verified_tenant_domain(text) owner to helix_migration_owner;
revoke all on function helix_verified_tenant_domain(text) from public;
grant execute on function helix_verified_tenant_domain(text) to helix_app;
