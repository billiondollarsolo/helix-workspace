alter table docs_comments
  add column if not exists parent_comment_id uuid;

create index if not exists docs_comments_parent_created_idx
  on docs_comments (parent_comment_id, created_at)
  where parent_comment_id is not null;

do $$
begin
  alter table docs_comments
    add constraint docs_comments_parent_comment_fk
    foreign key (parent_comment_id)
    references docs_comments(id)
    on delete cascade;
exception
  when duplicate_object then null;
end $$;
