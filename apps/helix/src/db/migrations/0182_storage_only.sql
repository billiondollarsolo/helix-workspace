-- Retire document editing and preview-generation state. Stored objects and
-- immutable file versions remain the authoritative file-storage records.
DROP TABLE IF EXISTS docs_ask_history, docs_comments, docs_suggestions,
  docs_updates, docs_revisions, docs_styles, docs_themes, docs_documents,
  sheet_cells, sheet_op_log, sheet_tabs, sheets,
  slides_op_log, slides, slide_decks,
  drive_pdf_form_states, drive_preview_jobs CASCADE;
