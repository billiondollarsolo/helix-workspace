alter table tenant_import_jobs
  add column if not exists has_remap_input boolean not null default false,
  add column if not exists remap_input_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(remap_input_summary) = 'object');
