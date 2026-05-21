alter table mail_outbound_messages
  add column if not exists provider_message_id text,
  add column if not exists delivery_metadata jsonb not null default '{}'::jsonb;

create index if not exists mail_outbound_provider_message_idx
  on mail_outbound_messages (provider_message_id)
  where provider_message_id is not null;
