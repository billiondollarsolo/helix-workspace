-- Persist spreadsheet formula evaluation metadata so reads do not depend on
-- ad-hoc serializer recomputation and dependent formulas can be refreshed when
-- a tab changes.

alter table sheet_cells
  add column if not exists formula text,
  add column if not exists calc_value text,
  add column if not exists dependencies jsonb not null default '[]'::jsonb,
  add column if not exists formula_error text;

update sheet_cells
set
  formula = null,
  calc_value = value,
  dependencies = '[]'::jsonb,
  formula_error = null
where calc_value is null;
