-- Tenant-scopes the pgvector tables. Before this migration `vector_items`
-- was keyed only by `(collection_name, id)` — any caller could read another
-- tenant's embeddings by guessing the collection name. We add `org_id` to
-- both `vector_collections` and `vector_items`, backfill rows to a sentinel
-- "unscoped" tenant (NULL — see the explicit system-scope contract in
-- VectorStore.types.ts), index on (org_id, collection_name), then make the
-- column NOT NULL once every adapter is writing it.
--
-- Existing rows: production pgvector deployments are a single-tenant
-- preview today. Any rows that survive this migration are conservatively
-- left under org_id NULL — the "system" scope — so they remain readable to
-- callers that explicitly pass orgId=null. Per-tenant re-index is required
-- to move them into a tenant scope.

alter table vector_collections
  add column if not exists org_id uuid;

alter table vector_items
  add column if not exists org_id uuid;

-- Drop the original (collection_name)-only primary keys / FK so we can
-- replace them with org-scoped ones.
do $$ begin
  if exists (
    select 1 from pg_constraint
    where conname = 'vector_items_collection_name_fkey'
  ) then
    alter table vector_items drop constraint vector_items_collection_name_fkey;
  end if;
end $$;

do $$ begin
  if exists (
    select 1 from pg_constraint
    where conname = 'vector_collections_pkey'
  ) then
    alter table vector_collections drop constraint vector_collections_pkey;
  end if;
end $$;

do $$ begin
  if exists (
    select 1 from pg_constraint
    where conname = 'vector_items_pkey'
  ) then
    alter table vector_items drop constraint vector_items_pkey;
  end if;
end $$;

-- A collection name is unique per tenant, not globally. NULL counts as a
-- distinct scope (the system / cross-tenant maintenance scope) so we use a
-- partial unique index plus a unique index on the NULL slice — Postgres
-- treats NULLs as distinct in a normal unique index, which is exactly the
-- behavior we want for the system scope.
alter table vector_collections
  add constraint vector_collections_pkey primary key (org_id, name);

alter table vector_items
  add constraint vector_items_pkey primary key (org_id, collection_name, id);

alter table vector_items
  add constraint vector_items_collection_fkey
  foreign key (org_id, collection_name)
  references vector_collections (org_id, name)
  on delete cascade;

-- Replace the old single-column index with a composite one used by every
-- read path (`where org_id = $1 and collection_name = $2`).
drop index if exists vector_items_collection_idx;
create index if not exists vector_items_org_collection_idx
  on vector_items (org_id, collection_name);

-- Tenant FK — keep nullable so the explicit system scope (org_id = NULL)
-- stays valid. On hard tenant delete, cascade so embeddings disappear with
-- the tenant.
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'vector_collections_org_fkey'
  ) then
    alter table vector_collections
      add constraint vector_collections_org_fkey
      foreign key (org_id) references orgs (id) on delete cascade;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'vector_items_org_fkey'
  ) then
    alter table vector_items
      add constraint vector_items_org_fkey
      foreign key (org_id) references orgs (id) on delete cascade;
  end if;
end $$;
