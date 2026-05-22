-- Slides plugin (BE-slides, wiring plan 2026-05-21): presentation decks and
-- their ordered slides. A `slide_decks` row owns N `slides` rows; each slide
-- has a `layout` discriminant (title/agenda/stats/split/bullets/image) and a
-- `content` JSONB body whose shape is determined by that layout, plus optional
-- speaker notes. Deletes are soft (decks) / cascading (slides).

create table if not exists slide_decks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  title text not null,
  owner_actor_id uuid references actors(id),
  created_by_actor_id uuid references actors(id),
  metadata jsonb not null default '{}',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists slide_decks_org_updated_idx on slide_decks (org_id, updated_at);
create index if not exists slide_decks_owner_idx on slide_decks (owner_actor_id);

create table if not exists slides (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  deck_id uuid not null references slide_decks(id) on delete cascade,
  position integer not null,
  layout text not null,
  content jsonb not null default '{}',
  speaker_notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists slides_deck_position_idx on slides (deck_id, position);
create index if not exists slides_org_deck_idx on slides (org_id, deck_id);
