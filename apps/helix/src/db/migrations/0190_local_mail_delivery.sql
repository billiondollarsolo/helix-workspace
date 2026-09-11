-- Delivery direction belongs to the mailbox, including mail sent to oneself.
alter table mail_message_deliveries add column received_at timestamptz;
update mail_message_deliveries delivery
set received_at = delivery.delivered_at
from messages message
where message.id = delivery.message_id and message.org_id = delivery.org_id
  and (message.metadata->>'direction' is distinct from 'outbound'
       or message.actor_id is distinct from delivery.actor_id);
alter table mail_message_deliveries alter column received_at set default now();
