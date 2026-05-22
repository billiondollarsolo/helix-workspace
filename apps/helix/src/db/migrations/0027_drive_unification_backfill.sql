-- 0027_drive_unification_backfill.sql
-- Backfill shared-PK `objects` rows so existing sheets/decks/docs are Drive entries.
-- Pure data migration: no schema/enum change.

insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata, deleted_at)
select s.id, s.org_id, s.owner_actor_id, 'file',
       'sheets/' || s.org_id || '/' || s.id,
       'application/vnd.helix.spreadsheet', 0, null,
       jsonb_build_object('app', 'sheets', 'name', s.title, 'title', s.title, 'folderId', null),
       s.deleted_at
from sheets s
on conflict (id) do nothing;

insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata, deleted_at)
select d.id, d.org_id, d.owner_actor_id, 'file',
       'slides/' || d.org_id || '/' || d.id,
       'application/vnd.helix.presentation', 0, null,
       jsonb_build_object('app', 'slides', 'name', d.title, 'title', d.title, 'folderId', null),
       d.deleted_at
from slide_decks d
on conflict (id) do nothing;

insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata, deleted_at)
select dd.id, dd.org_id, dd.owner_actor_id, 'file',
       'docs/' || dd.org_id || '/' || dd.id,
       'application/vnd.helix.document', 0, null,
       jsonb_build_object('app', 'docs', 'name', dd.title, 'title', dd.title, 'folderId', null),
       dd.deleted_at
from docs_documents dd
on conflict (id) do nothing;
