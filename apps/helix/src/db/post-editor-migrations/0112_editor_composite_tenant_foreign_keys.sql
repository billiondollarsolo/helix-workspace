-- Editor-owned tables are installed after platform migrations. Complete the
-- tenant relationship contract once those tables exist.

create unique index if not exists docs_documents_org_id_id_unique_idx
  on docs_documents (org_id, id);

alter table docs_revisions
  drop constraint if exists docs_revisions_document_id_fkey,
  drop constraint if exists docs_revisions_created_by_actor_id_fkey;
alter table docs_styles
  drop constraint if exists docs_styles_document_id_fkey;
alter table docs_themes
  drop constraint if exists docs_themes_document_id_fkey;

alter table docs_revisions
  add constraint docs_revisions_document_id_fkey
    foreign key (org_id, document_id)
    references docs_documents (org_id, id) on delete cascade,
  add constraint docs_revisions_created_by_actor_id_fkey
    foreign key (org_id, created_by_actor_id)
    references actors (org_id, id);
alter table docs_styles
  add constraint docs_styles_document_id_fkey
    foreign key (org_id, document_id)
    references docs_documents (org_id, id) on delete cascade;
alter table docs_themes
  add constraint docs_themes_document_id_fkey
    foreign key (org_id, document_id)
    references docs_documents (org_id, id) on delete cascade;

