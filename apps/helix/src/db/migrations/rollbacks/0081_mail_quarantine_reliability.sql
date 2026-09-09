do $$
begin
  if exists (select 1 from mail_quarantined_messages)
    or exists (select 1 from mail_outbound_messages where idempotency_key is not null)
    or exists (select 1 from mail_drafts where version > 1)
  then
    raise exception
      'refusing 0081 rollback: quarantine, idempotency, or draft-version evidence exists';
  end if;
end
$$;

drop trigger if exists mail_quarantine_same_org on mail_quarantined_messages;
drop function if exists mail_quarantine_validate_tenant();
drop table if exists mail_quarantined_messages;
drop index if exists mail_outbound_idempotency_idx;
alter table mail_outbound_messages drop column if exists idempotency_key;
alter table mail_drafts drop column if exists version;
