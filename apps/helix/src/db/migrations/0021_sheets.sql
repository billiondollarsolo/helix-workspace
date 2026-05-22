-- Sheets plugin: spreadsheets, tabs, and cell data.
--
-- A `sheets` row is one spreadsheet file. Each spreadsheet has one or more
-- ordered `sheet_tabs`. Cell data is stored sparsely in `sheet_cells`: only
-- non-empty cells are persisted, one row per (tab, row, col) coordinate. This
-- keeps storage proportional to populated cells rather than the grid extent,
-- and lets `sheets.cells.update` apply targeted batch upserts/clears.

create table if not exists sheets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  owner_actor_id uuid references actors(id),
  created_by_actor_id uuid references actors(id),
  title text not null,
  metadata jsonb not null default '{}',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sheets_org_updated_idx on sheets (org_id, updated_at);
create index if not exists sheets_owner_idx on sheets (owner_actor_id, deleted_at);

create table if not exists sheet_tabs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  sheet_id uuid not null references sheets(id) on delete cascade,
  name text not null,
  position integer not null default 0,
  metadata jsonb not null default '{}',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sheet_tabs_sheet_position_idx on sheet_tabs (sheet_id, position);
create index if not exists sheet_tabs_org_idx on sheet_tabs (org_id);

create table if not exists sheet_cells (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  sheet_tab_id uuid not null references sheet_tabs(id) on delete cascade,
  row integer not null,
  col integer not null,
  value text not null default '',
  format jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sheet_cells_non_negative check (row >= 0 and col >= 0)
);

create unique index if not exists sheet_cells_tab_coord_idx on sheet_cells (sheet_tab_id, row, col);
create index if not exists sheet_cells_org_idx on sheet_cells (org_id);
