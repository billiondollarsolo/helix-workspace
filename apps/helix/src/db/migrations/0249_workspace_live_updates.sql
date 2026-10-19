-- Browser invalidations carry no message content or configuration values.
alter table actor_events drop constraint actor_events_type_check;
alter table actor_events add check (type in ('chat.direct','chat.mentioned','chat.message','mail.received','mail.updated','approval.requested','approval.updated','notification'));

create function helix_project_workspace_update() returns trigger
language plpgsql security definer set search_path=pg_catalog,public set row_security=off as $$
begin
 if tg_table_name='platform_config' then
  perform pg_notify('helix_workspace_config','updated');
  return null;
 elsif tg_table_name='notifications' then
  perform helix_append_actor_event(new.org_id,new.actor_id,'notification',new.id,null);
 elsif tg_table_name='mail_thread_state' then
  if tg_op='DELETE' then
   perform helix_append_actor_event(old.org_id,old.actor_id,'mail.updated',old.actor_id,null);
   return old;
  end if;
  perform helix_append_actor_event(new.org_id,new.actor_id,'mail.updated',new.actor_id,null);
 elsif tg_table_name='mail_message_deliveries' and new.sent_at is not null then
  perform helix_append_actor_event(new.org_id,new.actor_id,'mail.updated',new.actor_id,null);
 end if;
 return new;
end $$;
alter function helix_project_workspace_update() owner to helix_migration_owner;
revoke all on function helix_project_workspace_update() from public;

create trigger mail_state_live_update after insert or update of labels,archived_at,deleted_at,snoozed_until,read_at,starred,spam_at or delete
 on mail_thread_state for each row execute function helix_project_workspace_update();
create trigger mail_sent_live_update after insert or update of sent_at on mail_message_deliveries
 for each row execute function helix_project_workspace_update();
create trigger notification_read_live_update after update of read_at on notifications
 for each row when (old.read_at is distinct from new.read_at) execute function helix_project_workspace_update();
create trigger configuration_live_update after insert or update or delete on platform_config
 for each statement execute function helix_project_workspace_update();
