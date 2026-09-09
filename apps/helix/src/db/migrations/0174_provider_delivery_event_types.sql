-- Preserve provider distinctions while using the durable delivery lifecycle.
alter table mail_delivery_events add column provider_event_type text
  check (provider_event_type in ('delivered', 'delayed', 'soft_bounce', 'hard_bounce', 'complaint', 'rejected'));
