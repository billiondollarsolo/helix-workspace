-- Stop outbound workers/webhooks and take a verified backup before rollback.
do $$
begin
  if exists (select 1 from mail_provider_delivery_events)
    or exists (select 1 from mail_suppressions)
    or exists (
      select 1 from mail_outbound_messages where provider_decided_at is not null
    )
  then
    raise exception
      'refusing 0079 rollback: provider routing or delivery evidence exists; restore from backup';
  end if;
end
$$;

drop trigger if exists mail_suppression_same_org on mail_suppressions;
drop function if exists mail_suppression_validate_tenant();
drop table if exists mail_suppressions;
drop trigger if exists mail_provider_event_same_org on mail_provider_delivery_events;
drop function if exists mail_provider_event_validate_tenant();
drop table if exists mail_provider_delivery_events;
drop index if exists mail_outbound_provider_binding_idx;

alter table mail_outbound_messages
  drop constraint if exists mail_outbound_provider_decision_source_check,
  drop constraint if exists mail_outbound_delivery_status_check,
  drop column if exists delivery_event_at,
  drop column if exists delivery_status,
  drop column if exists provider_decided_at,
  drop column if exists provider_decision_source,
  drop column if exists provider_kind,
  drop column if exists provider_id;

alter table mail_outbound_providers
  drop column if exists webhook_secret_ref;
