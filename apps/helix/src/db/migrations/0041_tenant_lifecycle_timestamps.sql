alter table orgs
  add column if not exists suspended_at timestamptz;
