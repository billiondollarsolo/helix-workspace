-- Move proof of domain ownership onto the domain itself.
--
-- Helix had three ideas of what "verified" meant and only one of them was real:
--
--   * mail_receiving_domains  -- a TXT challenge, SHA-256 digest, constant-time
--                                compare. Genuine, and it gated SMTP.
--   * mail_sending_domains    -- `verified_at = now()` because the CALLER said
--                                so. Removed in the same change as this.
--   * admin_domains           -- real DNS record checks, consumed by nothing.
--
-- Ownership belongs to the domain, not to one thing you do with it: proving you
-- control example.com to receive mail also proves it for sending. The real
-- challenge therefore moves up to admin_domains, and the capabilities read it.
--
-- admin_domains also adopts the constraints its younger sibling shipped with in
-- 0075 and it never had -- canonical lowercase domain, and a foreign key to
-- orgs so deleting a tenant does not strand its domains.

-- 1. The proof itself. Nullable: a domain can be registered before anyone
--    starts proving it, and that state has to be representable.
alter table admin_domains
  add column if not exists verification_token_hash text;

alter table admin_domains
  drop constraint if exists admin_domains_token_hash_sha256;
alter table admin_domains
  add constraint admin_domains_token_hash_sha256 check (
    verification_token_hash is null or verification_token_hash ~ '^[a-f0-9]{64}$'
  );

-- 2. Inherit the proof already satisfied by a receiving capability, so a
--    domain an operator has verified does not silently become unproven.
--
--    Guarded on the column still existing: step 5 drops it, so an unguarded
--    replay of this file fails here rather than being a no-op. A migration that
--    cannot be run twice cannot be safely retried after a partial failure.
do $migrate$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = current_schema()
      and table_name = 'mail_receiving_domains'
      and column_name = 'verification_token_hash'
  ) then
    execute $inherit$
      update admin_domains p
      set verification_token_hash = c.verification_token_hash,
          verification_status = 'verified',
          verified_at = coalesce(p.verified_at, c.verified_at),
          updated_at = now()
      from mail_receiving_domains c
      where c.admin_domain_id = p.id
        and c.status in ('verified', 'active', 'disabled')
        and p.verification_token_hash is null
    $inherit$;

    -- Carry the outstanding challenge across too: a domain mid-verification
    -- keeps the TXT record its operator has already published.
    execute $carry$
      update admin_domains p
      set verification_token_hash = c.verification_token_hash, updated_at = now()
      from mail_receiving_domains c
      where c.admin_domain_id = p.id
        and c.status = 'pending'
        and p.verification_token_hash is null
    $carry$;
  end if;
end
$migrate$;

-- 3. Canonicalise before constraining. admin_domains only ever normalised in
--    its index (`lower(domain)`), so stored values may carry mixed case.
update admin_domains set domain = lower(domain), updated_at = now()
where domain <> lower(domain);

alter table admin_domains
  drop constraint if exists admin_domains_domain_canonical;
alter table admin_domains
  add constraint admin_domains_domain_canonical check (
    domain = lower(domain)
    and octet_length(domain) between 1 and 253
    and domain ~ '^[a-z0-9.-]+$'
    and domain !~ '(^[.]|[.]$|[.][.]|(^|[.])-|-([.]|$))'
    and domain !~ '(^|[.])[a-z0-9-]{64,}([.]|$)'
  );

-- 4. A domain belongs to a tenant. Rows whose org is already gone are removed
--    first -- they are unreachable through every org-scoped query as it is.
delete from admin_domains
where not exists (select 1 from orgs o where o.id = admin_domains.org_id);

alter table admin_domains
  drop constraint if exists admin_domains_org_id_fkey;
alter table admin_domains
  add constraint admin_domains_org_id_fkey
  foreign key (org_id) references orgs (id) on delete cascade;

-- 5. The capability's copy is now a second source of truth for the same fact.
alter table mail_receiving_domains
  drop column if exists verification_token_hash;
