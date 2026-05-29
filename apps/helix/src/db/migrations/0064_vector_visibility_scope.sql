-- RAG visibility gating.
--
-- Adds per-item visibility scoping to vector_items so the assistant's
-- retrieval-augmented chat can correctly differentiate:
--   - `visibility = 'org'`   : indexed by an org-shared resource (a Drive file
--                              shared with the whole org, an org-published
--                              doc, etc.). Every member of org_id sees it.
--   - `visibility = 'private'` : indexed by a single user's private upload
--                              (their personal drive, an attachment they
--                              dropped into an assistant chat with no org
--                              visibility). Only `owner_actor_id` may
--                              retrieve it.
--
-- Default for backfilled rows is `'org'` because pre-migration code only had
-- one scope, equivalent to "everyone in the tenant" — flipping unknown legacy
-- rows to private would silently break existing assistant queries.

alter table vector_items
  add column if not exists owner_actor_id uuid;

alter table vector_items
  add column if not exists visibility text not null default 'org';

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'vector_items_visibility_check'
  ) then
    alter table vector_items
      add constraint vector_items_visibility_check
      check (visibility in ('org', 'private'));
  end if;
end $$;

-- Private items must name an owner; org items must NOT name an owner.
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'vector_items_owner_visibility_check'
  ) then
    alter table vector_items
      add constraint vector_items_owner_visibility_check
      check (
        (visibility = 'org' and owner_actor_id is null)
        or (visibility = 'private' and owner_actor_id is not null)
      );
  end if;
end $$;

-- The hot retrieval query is
--   where org_id = $1 and collection_name = $2
--     and (visibility = 'org' or (visibility = 'private' and owner_actor_id = $3))
-- so the supporting index covers org_id + collection_name + visibility, with
-- owner_actor_id available for the private-branch filter.
create index if not exists vector_items_org_collection_visibility_idx
  on vector_items (org_id, collection_name, visibility);

create index if not exists vector_items_owner_idx
  on vector_items (org_id, owner_actor_id)
  where visibility = 'private';
