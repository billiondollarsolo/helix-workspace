-- Keep the raw bytes where main stored them until an administrator resolves the
-- quarantine. New uploads continue to use tenant object storage. This avoids a
-- deployment-time copy requiring live object-store credentials or losing evidence.
create unique index if not exists mail_quarantined_messages_org_id_uidx
  on mail_quarantined_messages (org_id, id);
alter table mail_quarantines add column legacy_source_id uuid;
alter table mail_quarantines add constraint mail_quarantines_legacy_source_fk
  foreign key (org_id, legacy_source_id) references mail_quarantined_messages(org_id, id)
  on delete restrict;
create unique index mail_quarantines_legacy_source_idx
  on mail_quarantines (org_id, legacy_source_id) where legacy_source_id is not null;

insert into mail_quarantines (
  id, org_id, recipient_addresses, envelope_from, storage_key, byte_size, sha256,
  signature, authentication, scan_evidence, created_at, legacy_source_id
)
select id, org_id, envelope_to, envelope_from,
  'legacy-mail-quarantine/' || org_id::text || '/' || id::text,
  octet_length(raw_message), encode(digest(raw_message, 'sha256'), 'hex'),
  left(array_to_string(reasons, '; '), 512), auth_evidence,
  scan_evidence || jsonb_build_object('legacyReasons', reasons, 'legacyStatus', status),
  created_at, id
from mail_quarantined_messages
where status in ('quarantined', 'rescanning') and raw_message is not null;

-- Legacy bytes and historical records have the same administrator-only boundary
-- as current quarantine records, including access through direct database roles.
alter table mail_quarantined_messages force row level security;
drop policy if exists helix_tenant_isolation on mail_quarantined_messages;
create policy helix_mail_quarantine_admin_only on mail_quarantined_messages
  using (helix_can_read_mail_quarantine(org_id))
  with check (helix_can_write_mail_quarantine(org_id));
