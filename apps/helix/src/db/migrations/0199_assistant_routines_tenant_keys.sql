-- 0198 created assistant_routines with single-column foreign keys, so a row
-- could point at an actor or conversation in another organization. Couple both
-- relationships to org_id, matching assistant_messages. The conversation link
-- still clears only conversation_id when the conversation is deleted.
alter table assistant_routines
  drop constraint if exists assistant_routines_actor_id_fkey,
  drop constraint if exists assistant_routines_conversation_id_fkey;

alter table assistant_routines
  add constraint assistant_routines_actor_id_fkey
    foreign key (org_id, actor_id)
    references actors (org_id, id) on delete cascade,
  add constraint assistant_routines_conversation_id_fkey
    foreign key (org_id, conversation_id)
    references assistant_conversations (org_id, id) on delete set null (conversation_id);
