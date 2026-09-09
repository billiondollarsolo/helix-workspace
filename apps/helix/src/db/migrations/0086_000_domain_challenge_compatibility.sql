-- Older production schemas lack server-generated ownership challenges. Supply
-- these before importing capability-only domains into the ownership registry.
alter table admin_domains
  add column if not exists verification_host text,
  add column if not exists verification_value text,
  add column if not exists verification_expires_at timestamptz,
  add column if not exists verification_attempts integer not null default 0,
  add column if not exists verification_last_attempt_at timestamptz;

update admin_domains
set verification_host = coalesce(verification_host, '_helix-verification.' || lower(domain)),
    verification_value = coalesce(verification_value, 'helix-verification=' || encode(gen_random_bytes(32), 'hex')),
    verification_expires_at = coalesce(verification_expires_at, now() + interval '24 hours');
alter table admin_domains
  alter column verification_host set not null,
  alter column verification_value set not null,
  alter column verification_expires_at set not null;

create or replace function helix_fill_legacy_domain_challenge() returns trigger
language plpgsql as $$
begin
  new.verification_host := coalesce(new.verification_host, '_helix-verification.' || lower(new.domain));
  new.verification_value := coalesce(new.verification_value, 'helix-verification=' || encode(gen_random_bytes(32), 'hex'));
  new.verification_expires_at := coalesce(new.verification_expires_at, now() + interval '24 hours');
  return new;
end;
$$;
create trigger admin_domains_fill_legacy_challenge before insert on admin_domains
for each row execute function helix_fill_legacy_domain_challenge();

do $$
begin
  if to_regclass('public.mail_sending_domains') is not null then
    create unique index if not exists admin_domains_org_domain_idx on admin_domains (org_id, lower(domain));
  end if;
end;
$$;
