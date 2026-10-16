-- Small, ordered notification references; source content retains its existing ACL.
create table actor_event_state (
 org_id uuid not null, actor_id uuid primary key, next_sequence bigint not null default 0,
 foreign key (org_id,actor_id) references actors(org_id,id) on delete cascade,
 check (next_sequence between 0 and 9007199254740991)
);
create table actor_events (
 org_id uuid not null, actor_id uuid not null, sequence bigint not null,
 type text not null check (type in ('chat.direct','chat.mentioned','chat.message','mail.received','approval.requested','approval.updated','notification')),
 resource_id uuid not null, parent_id uuid, created_at timestamptz not null default now(),
 primary key(actor_id,sequence),
 foreign key (org_id,actor_id) references actors(org_id,id) on delete cascade
);
create table actor_status (
 org_id uuid not null, actor_id uuid primary key,
 availability text not null default 'available' check (availability in ('available','away','dnd','invisible')),
 status_text text not null default '' check (char_length(status_text)<=100),
 emoji text not null default '' check (char_length(emoji)<=16), expires_at timestamptz,
 foreign key (org_id,actor_id) references actors(org_id,id) on delete cascade
);
create table actor_presence_connections (
 org_id uuid not null, actor_id uuid not null, connection_id uuid not null,
 state text not null check(state in ('idle','active','working','waiting_approval')),
 seen_at timestamptz not null default now(), primary key(actor_id,connection_id),
 foreign key(org_id,actor_id) references actors(org_id,id) on delete cascade
);
create function helix_presence_visible(tenant uuid, viewer uuid, target uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public set row_security=off as $$
 select tenant=helix_current_org_id() and viewer=helix_current_actor_id()
 and exists(select 1 from actors where id=target and org_id=tenant and disabled_at is null)
 and (viewer=target or (
  not exists(select 1 from chat_user_blocks b where b.org_id=tenant and
   ((b.blocker_actor_id=viewer and b.blocked_actor_id=target) or (b.blocker_actor_id=target and b.blocked_actor_id=viewer)))
  and exists(select 1 from permissions mine join permissions theirs on theirs.org_id=mine.org_id and theirs.resource_id=mine.resource_id
   join threads room on room.id=mine.resource_id and room.org_id=tenant
   where room.kind in ('chat_room','chat_dm') and chat_permission_is_valid(mine,tenant,viewer,room.id)
    and chat_permission_is_valid(theirs,tenant,target,room.id))
 ));
$$;
alter function helix_presence_visible(uuid,uuid,uuid) owner to helix_migration_owner;
revoke all on function helix_presence_visible(uuid,uuid,uuid) from public;
grant execute on function helix_presence_visible(uuid,uuid,uuid) to helix_app;

do $$ declare tab text; begin
 foreach tab in array array['actor_event_state','actor_events','actor_status','actor_presence_connections'] loop
 execute format('alter table %I enable row level security',tab);
 execute format('alter table %I force row level security',tab);
 execute format('create policy tenant_boundary on %I as restrictive for all using (org_id=helix_current_org_id()) with check (org_id=helix_current_org_id())',tab);
 execute format('create policy owner_access on %I for all using (actor_id=helix_current_actor_id()) with check (actor_id=helix_current_actor_id())',tab);
 execute format('alter table %I owner to helix_migration_owner',tab);
 end loop;
end $$;
create policy status_relationship_read on actor_status for select using(helix_presence_visible(org_id,helix_current_actor_id(),actor_id));
create policy presence_relationship_read on actor_presence_connections for select using(helix_presence_visible(org_id,helix_current_actor_id(),actor_id));
grant select on actor_events,actor_event_state to helix_app;
grant select,insert,update,delete on actor_status,actor_presence_connections to helix_app;

-- The allocator lock lasts until the source transaction commits: no cursor can overtake it.
create function helix_append_actor_event(tenant uuid, recipient uuid, event_type text, resource uuid, parent uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public set row_security=off as $$
declare seq bigint;
begin
 if not exists(select 1 from actors where org_id=tenant and id=recipient and disabled_at is null) then return; end if;
 insert into actor_event_state(org_id,actor_id,next_sequence) values(tenant,recipient,1)
 on conflict(actor_id) do update set next_sequence=actor_event_state.next_sequence+1 returning next_sequence into seq;
 insert into actor_events(org_id,actor_id,sequence,type,resource_id,parent_id) values(tenant,recipient,seq,event_type,resource,parent);
 -- Bounded replay is transport state, not the audit or retention source.
 delete from actor_events where actor_id=recipient and (sequence<=seq-10000 or created_at<now()-interval '7 days');
 perform pg_notify('helix_actor_events',json_build_object('orgId',tenant,'actorId',recipient)::text);
end $$;
alter function helix_append_actor_event(uuid,uuid,text,uuid,uuid) owner to helix_migration_owner;
revoke all on function helix_append_actor_event(uuid,uuid,text,uuid,uuid) from public;

create function helix_project_actor_event() returns trigger
language plpgsql security definer set search_path=pg_catalog,public set row_security=off as $$
declare room uuid; event_type text; recipient uuid;
begin
 if tg_table_name='notifications' then
  if new.object_type='chat.message' and new.verb in ('chat.mentioned','chat.message.created') then
   select m.thread_id, case when new.verb='chat.mentioned' then 'chat.mentioned' when t.kind='chat_dm' then 'chat.direct' else 'chat.message' end
    into room,event_type from messages m join threads t on t.id=m.thread_id and t.org_id=m.org_id where m.id=new.object_id and m.org_id=new.org_id;
   if room is not null then perform helix_append_actor_event(new.org_id,new.actor_id,event_type,new.object_id,room); end if;
  elsif new.object_type<>'pending_action' then
   perform helix_append_actor_event(new.org_id,new.actor_id,'notification',new.id,null);
  end if;
 elsif tg_table_name='mail_message_deliveries' then
  if new.received_at is not null and (tg_op='INSERT' or old.received_at is null) then
   select thread_id into room from messages where org_id=new.org_id and id=new.message_id;
   perform helix_append_actor_event(new.org_id,new.actor_id,'mail.received',new.message_id,room);
  end if;
 elsif tg_table_name='pending_actions' then
  if (tg_op='INSERT' or old.status is distinct from new.status)
   and new.status in ('pending_confirmation','executed','failed','cancelled','expired') then
   for recipient in select distinct id from unnest(array[new.actor_id,new.approval_owner_actor_id]) id where id is not null order by id loop
    perform helix_append_actor_event(new.org_id,recipient,case when new.status='pending_confirmation' then 'approval.requested' else 'approval.updated' end,new.id,null);
   end loop;
  end if;
 end if;
 return new;
end $$;
alter function helix_project_actor_event() owner to helix_migration_owner;
revoke all on function helix_project_actor_event() from public;
create trigger notifications_live_event after insert on notifications for each row execute function helix_project_actor_event();
create trigger mail_delivery_live_event after insert or update of received_at on mail_message_deliveries for each row execute function helix_project_actor_event();
create trigger approval_live_event after insert or update of status on pending_actions for each row execute function helix_project_actor_event();
