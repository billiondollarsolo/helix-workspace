-- Roll back 0087_domain_ownership_proof.
--
-- The capability's own token hash column can be restored, but the tokens
-- themselves cannot: only digests were ever stored, and 0087 moved the digest
-- to the parent. Every receiving domain therefore comes back holding a
-- placeholder digest that no TXT record can satisfy, and each one has to be
-- re-challenged from the console.
--
-- Restoring the column is preferred over leaving it dropped because the pre-
-- 0087 code reads it and would fail at boot without it.

alter table mail_receiving_domains
  add column if not exists verification_token_hash text;

-- A digest of a value nobody holds: unsatisfiable by construction, which is the
-- honest state. Reissuing the challenge is the recovery path.
update mail_receiving_domains
set verification_token_hash = repeat('0', 64)
where verification_token_hash is null;

alter table mail_receiving_domains
  alter column verification_token_hash set not null;

alter table admin_domains drop constraint if exists admin_domains_org_id_fkey;
alter table admin_domains drop constraint if exists admin_domains_domain_canonical;
alter table admin_domains drop constraint if exists admin_domains_token_hash_sha256;
alter table admin_domains drop column if exists verification_token_hash;
