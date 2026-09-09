-- MAIL-14: tenant DKIM keys are KMS/HSM-wrapped and become active only after
-- their public DNS record has been verified. Legacy app-enveloped PEMs cannot
-- be rewrapped without plaintext access during migration, so invalidate them.

-- Recreate rather than ALTER TYPE ADD VALUE because migrations are atomic and
-- PostgreSQL cannot use a newly-added enum value until its transaction commits.
alter type mail_dkim_key_status rename to mail_dkim_key_status_legacy;
create type mail_dkim_key_status as enum ('pending', 'active', 'retiring', 'retired');
drop index if exists mail_dkim_keys_domain_active_idx;
alter table mail_dkim_keys alter column status drop default;
alter table mail_dkim_keys
  alter column status type mail_dkim_key_status
  using status::text::mail_dkim_key_status;
drop type mail_dkim_key_status_legacy;
create unique index mail_dkim_keys_domain_active_idx
  on mail_dkim_keys (domain_id) where status = 'active';

alter table mail_dkim_keys
  add column if not exists kms_key_id text,
  add column if not exists activated_at timestamptz,
  add column if not exists verified_at timestamptz;

delete from mail_dkim_keys where kms_key_id is null;

alter table mail_dkim_keys
  alter column status set default 'pending',
  alter column kms_key_id set not null,
  drop constraint if exists mail_dkim_keys_private_key_ciphertext_check;

alter table mail_dkim_keys
  add constraint mail_dkim_keys_private_key_ciphertext_check check (
    length(private_key_ciphertext) >= 32
    and private_key_ciphertext ~ '^[A-Za-z0-9+/]+={0,2}$'
  ),
  add constraint mail_dkim_keys_kms_key_id_check check (
    char_length(kms_key_id) between 1 and 2048
  ),
  add constraint mail_dkim_keys_lifecycle_check check (
    (status = 'pending' and activated_at is null and verified_at is null)
    or (status <> 'pending' and activated_at is not null and verified_at is not null)
  );
