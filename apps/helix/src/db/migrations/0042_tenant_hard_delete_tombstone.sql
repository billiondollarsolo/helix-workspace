alter type org_status add value if not exists 'hard_deleted';

alter table orgs
  add column if not exists hard_deleted_at timestamptz;
