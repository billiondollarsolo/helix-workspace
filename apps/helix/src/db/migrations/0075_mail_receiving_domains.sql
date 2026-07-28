do $$ begin
  create type mail_receiving_domain_status as enum ('pending', 'verified', 'active', 'disabled');
exception when duplicate_object then null; end $$;

create table if not exists mail_receiving_domains (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  domain text not null,
  status mail_receiving_domain_status not null default 'pending',
  verification_token_hash text not null,
  verified_at timestamptz,
  catch_all_actor_id uuid references actors(id) on delete set null,
  created_by uuid references actors(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mail_receiving_domains_domain_canonical check (
    domain = lower(domain)
    and octet_length(domain) between 1 and 253
    and domain ~ '^[a-z0-9.-]+$'
    and domain !~ '(^[.]|[.]$|[.][.]|(^|[.])-|-([.]|$))'
    and domain !~ '(^|[.])[a-z0-9-]{64,}([.]|$)'
  ),
  constraint mail_receiving_domains_token_hash_sha256 check (
    verification_token_hash ~ '^[a-f0-9]{64}$'
  ),
  constraint mail_receiving_domains_verified_state check (
    (status = 'pending' and verified_at is null)
    or (status in ('verified', 'active', 'disabled') and verified_at is not null)
  )
);

create unique index if not exists mail_receiving_domains_org_domain_idx
  on mail_receiving_domains (org_id, domain);
create unique index if not exists mail_receiving_domains_active_domain_idx
  on mail_receiving_domains (domain)
  where status = 'active';
create unique index if not exists mail_receiving_domains_token_hash_idx
  on mail_receiving_domains (verification_token_hash);
create index if not exists mail_receiving_domains_org_status_idx
  on mail_receiving_domains (org_id, status, created_at desc);

create or replace function mail_receiving_domains_validate_catch_all()
returns trigger
language plpgsql
as $$
begin
  if new.catch_all_actor_id is not null and not exists (
    select 1
    from actors
    where id = new.catch_all_actor_id
      and org_id = new.org_id
      and disabled_at is null
  ) then
    raise exception 'catch-all actor must be active and belong to the receiving-domain organization'
      using errcode = '23514',
            constraint = 'mail_receiving_domains_catch_all_same_org';
  end if;
  return new;
end
$$;

drop trigger if exists mail_receiving_domains_catch_all_same_org
  on mail_receiving_domains;
create trigger mail_receiving_domains_catch_all_same_org
before insert or update of org_id, catch_all_actor_id
on mail_receiving_domains
for each row
execute function mail_receiving_domains_validate_catch_all();

create or replace function mail_receiving_domains_guard_actor_org_change()
returns trigger
language plpgsql
as $$
begin
  if new.org_id is distinct from old.org_id and exists (
    select 1
    from mail_receiving_domains
    where catch_all_actor_id = old.id
      and org_id <> new.org_id
  ) then
    raise exception 'actor organization cannot change while configured as a receiving-domain catch-all'
      using errcode = '23514',
            constraint = 'mail_receiving_domains_catch_all_same_org';
  end if;
  return new;
end
$$;

drop trigger if exists mail_receiving_domains_guard_actor_org_change on actors;
create trigger mail_receiving_domains_guard_actor_org_change
before update of org_id
on actors
for each row
execute function mail_receiving_domains_guard_actor_org_change();

alter table mail_receiving_domains enable row level security;
drop policy if exists helix_tenant_isolation on mail_receiving_domains;
create policy helix_tenant_isolation on mail_receiving_domains
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

-- Deliberately no automatic backfill. Operators must use the explicit
-- single-tenant backfill command with an exact organization and domain;
-- public/SaaS mode must never infer a tenant from existing rows.
