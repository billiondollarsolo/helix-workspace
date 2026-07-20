-- Chat message threading: parent/child replies within a room.
alter table messages add column if not exists parent_message_id uuid null references messages(id) on delete set null;
create index if not exists messages_parent_idx on messages (parent_message_id) where parent_message_id is not null;
