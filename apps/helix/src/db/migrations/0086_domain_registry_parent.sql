-- Link the two mail domain capabilities to the domain identity they belong to.
--
-- Helix modelled the same domain three times with nothing joining them:
--   * admin_domains          -- the org owns this domain (+ admin_dns_records)
--   * mail_sending_domains   -- may send FROM it (+ DKIM keys, provider)
--   * mail_receiving_domains -- accepts mail FOR it (+ ownership challenge)
--
-- They are not peers. The first is an identity record; the other two are
-- capabilities switched on once that identity is proven. The clearest evidence
-- is the admin console: the Sending domains view asks for SPF/DKIM/DMARC state
-- that already exists in admin_dns_records and had no way to reach it.
--
-- This migration only establishes the parent link and backfills it. Moving the
-- ownership proof up to admin_domains is a separate step; nothing here changes
-- how a domain is verified.

alter table mail_sending_domains
  add column if not exists admin_domain_id uuid references admin_domains (id) on delete cascade;

alter table mail_receiving_domains
  add column if not exists admin_domain_id uuid references admin_domains (id) on delete cascade;

-- 1. Create the missing parent for every capability row that has none.
--
-- admin_domains already carries `unique (org_id, lower(domain))`, so the
-- canonical key is (org_id, lower(domain)) and one insert per distinct pair is
-- both necessary and sufficient. `on conflict do nothing` covers the case where
-- a sending and a receiving row name the same domain.
--
-- A receiving domain past `pending` has satisfied a real TXT challenge, so the
-- parent it creates inherits that proof. A sending domain proves nothing today
-- -- its verified_at was written from a client-supplied boolean -- so it seeds
-- a `pending` parent rather than laundering a self-assertion into ownership.
insert into admin_domains (org_id, domain, verification_status, verified_at, created_by, created_at)
select
  source.org_id,
  source.domain,
  case when source.proven_at is null then 'pending' else 'verified' end,
  source.proven_at,
  source.created_by,
  source.created_at
from (
  select
    org_id,
    lower(domain) as domain,
    max(proven_at) as proven_at,
    -- Whoever registered the earliest capability is the closest thing to the
    -- domain's registrar. (No min(uuid) exists, and picking one arbitrarily
    -- would attribute the domain to a random admin.)
    (array_agg(created_by order by created_at, domain))[1] as created_by,
    min(created_at) as created_at
  from (
    select org_id, domain, null::timestamptz as proven_at, created_by, created_at
    from mail_sending_domains
    union all
    select
      org_id,
      domain,
      case when status = 'pending' then null else verified_at end,
      created_by,
      created_at
    from mail_receiving_domains
  ) as capability
  group by org_id, lower(domain)
) as source
where not exists (
  select 1 from admin_domains existing
  where existing.org_id = source.org_id
    and lower(existing.domain) = source.domain
)
on conflict (org_id, (lower(domain))) do nothing;

-- 2. Point every capability row at its parent.
update mail_sending_domains as capability
set admin_domain_id = parent.id
from admin_domains as parent
where capability.admin_domain_id is null
  and parent.org_id = capability.org_id
  and lower(parent.domain) = lower(capability.domain);

update mail_receiving_domains as capability
set admin_domain_id = parent.id
from admin_domains as parent
where capability.admin_domain_id is null
  and parent.org_id = capability.org_id
  and lower(parent.domain) = lower(capability.domain);

-- 3. A capability without an identity is the state this migration exists to
--    make unrepresentable, so the column is mandatory from here on.
alter table mail_sending_domains
  alter column admin_domain_id set not null;

alter table mail_receiving_domains
  alter column admin_domain_id set not null;

-- One capability row of each kind per domain. Previously an org could register
-- the same sending domain twice; only the receiving side had a guard.
create unique index if not exists mail_sending_domains_parent_idx
  on mail_sending_domains (admin_domain_id);

create unique index if not exists mail_receiving_domains_parent_idx
  on mail_receiving_domains (admin_domain_id);

-- The capability's own org_id is now derivable from its parent. It is kept
-- (every query filters on it, and dropping it would rewrite every store) but
-- it must not be able to disagree with the parent's.
create index if not exists mail_sending_domains_org_parent_idx
  on mail_sending_domains (org_id, admin_domain_id);

create index if not exists mail_receiving_domains_org_parent_idx
  on mail_receiving_domains (org_id, admin_domain_id);
