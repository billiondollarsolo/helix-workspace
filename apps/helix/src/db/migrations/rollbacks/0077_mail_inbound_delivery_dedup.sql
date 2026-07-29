-- Rollback for 0077_mail_inbound_delivery_dedup.sql.
-- Stop inbound SMTP and take a verified backup before invoking. The guard
-- aborts if rollback would remove retry/idempotency evidence; restore the
-- pre-migration backup instead of deleting production evidence.

do $$
begin
  if exists (select 1 from mail_inbound_deliveries) then
    raise exception
      'refusing 0077 rollback: inbound delivery evidence exists; restore from backup';
  end if;
end
$$;

drop trigger if exists mail_inbound_recipients_same_org on mail_inbound_recipients;
drop function if exists mail_inbound_recipients_validate_tenant();
drop table if exists mail_inbound_recipients;
drop table if exists mail_inbound_deliveries;
