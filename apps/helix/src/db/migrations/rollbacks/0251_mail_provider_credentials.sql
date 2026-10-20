-- Application rollback needs no schema rollback; the added fields are backward compatible.
-- Refuse destructive rollback once encrypted credentials or the new configuration are in use.
do $$
begin
  if exists (select 1 from mail_outbound_providers where credential_ciphertext is not null or feedback_credential_ciphertext is not null or config ?| array['dkimMode', 'feedbackProvider']) then
    raise exception 'refusing 0251 rollback: mail provider credentials or signing settings are in use';
  end if;
end $$;
alter table mail_outbound_providers drop column credential_ciphertext, drop column feedback_credential_ciphertext;
