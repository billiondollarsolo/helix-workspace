alter table messages
  add column if not exists client_message_id text;

create unique index if not exists messages_chat_client_message_uidx
  on messages (org_id, actor_id, thread_id, client_message_id)
  where kind = 'chat' and client_message_id is not null;
