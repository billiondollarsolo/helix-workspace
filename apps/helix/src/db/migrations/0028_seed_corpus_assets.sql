-- 0028_seed_corpus_assets.sql
-- Idempotency registry for seed-corpus.ts. Maps a stable `manifest_id`
-- (declared once per item in apps/helix/seed/corpus/manifest.json) to the
-- random UUID that was assigned to the corresponding entity (doc, sheet,
-- slide deck, drive file, or drive folder) on first import. On re-seed:
--   * same manifest_id + same content_hash → no-op
--   * same manifest_id + new content_hash → update the entity in place
--   * new manifest_id                      → create a fresh entity with a
--                                            freshly-generated random UUID
-- Lets us repeatedly hydrate a developer's local workspace without ever
-- shipping fake fixture UUIDs into production code paths.

create table if not exists seed_corpus_assets (
  manifest_id   text primary key,
  org_id        uuid not null,
  entity_kind   text not null check (entity_kind in ('document','sheet','slide_deck','drive_file','drive_folder')),
  entity_id     uuid not null,
  drive_object_id uuid,
  owner_actor_id uuid not null,
  content_hash  text not null,
  source_url    text,
  imported_at   timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists seed_corpus_assets_org_idx
  on seed_corpus_assets (org_id);

create index if not exists seed_corpus_assets_entity_idx
  on seed_corpus_assets (entity_kind, entity_id);
