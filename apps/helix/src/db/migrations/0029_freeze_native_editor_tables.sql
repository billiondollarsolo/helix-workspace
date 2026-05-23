-- 0029_freeze_native_editor_tables.sql
--
-- Phase 6 of the OnlyOffice migration. The native Helix editor stack
-- (docs_documents + docs_updates + docs_comments + docs_suggestions,
-- sheets + sheet_tabs + sheet_cells, slide_decks + slides) has been
-- replaced by OnlyOffice DocumentServer + raw OOXML files stored on the
-- shared `objects` row.
--
-- Existing rows have been converted by `pnpm db:migrate:to-ooxml` —
-- each `objects.id` referenced by these tables now carries the matching
-- OOXML bytes inline. The native rows remain so legacy code can still
-- read them during the deprecation window, but no new code should write
-- to them; every new doc/sheet/slide creation must go through the
-- drive_file path with an OOXML mime type.
--
-- This migration is annotation-only (no DDL): it records the deprecation
-- decision in `COMMENT ON TABLE` metadata so DB inspectors / pgAdmin
-- show the warning, and the next-pass cleanup (after the legacy code is
-- removed) can drop these with confidence.

comment on table docs_documents is
  'DEPRECATED 2026-05-22: replaced by OOXML files on objects.id (see 0029_freeze_native_editor_tables.sql). Read-only during deprecation window; new writes must go through the drive_file path with mime=application/vnd.openxmlformats-officedocument.wordprocessingml.document.';

comment on table docs_updates is
  'DEPRECATED 2026-05-22: Yjs append-only log for docs_documents. OnlyOffice handles versioning + collaboration directly, so this table is no longer authoritative.';

comment on table docs_comments is
  'DEPRECATED 2026-05-22: native-editor comment store. Comments on OOXML files will move to a generic drive_comments table (planned).';

comment on table docs_suggestions is
  'DEPRECATED 2026-05-22: native-editor suggestion store. Comments / suggestions on OOXML files will move to a generic drive_suggestions table (planned).';

comment on table sheets is
  'DEPRECATED 2026-05-22: replaced by OOXML XLSX files on objects.id (see 0029_freeze_native_editor_tables.sql).';

comment on table sheet_tabs is
  'DEPRECATED 2026-05-22: now lives inside the XLSX binary, not as separate rows.';

comment on table sheet_cells is
  'DEPRECATED 2026-05-22: now lives inside the XLSX binary, not as separate rows.';

comment on table slide_decks is
  'DEPRECATED 2026-05-22: replaced by OOXML PPTX files on objects.id (see 0029_freeze_native_editor_tables.sql).';

comment on table slides is
  'DEPRECATED 2026-05-22: now lives inside the PPTX binary, not as separate rows.';
