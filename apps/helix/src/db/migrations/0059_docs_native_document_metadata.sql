alter table docs_documents
  add column if not exists editor_engine text not null default 'legacy-yjs',
  add column if not exists format_version integer not null default 1;

update docs_documents
set
  editor_engine = coalesce(
    nullif(docs_documents.metadata->>'editorEngine', ''),
    nullif(objects.metadata->>'editorEngine', ''),
    docs_documents.editor_engine
  ),
  format_version = coalesce(
    nullif(docs_documents.metadata->>'formatVersion', '')::integer,
    nullif(objects.metadata->>'formatVersion', '')::integer,
    docs_documents.format_version
  )
from objects
where objects.id = docs_documents.id
  and objects.org_id = docs_documents.org_id;
