alter table admin_groups
  add column if not exists external_id text;

create unique index if not exists admin_groups_org_external_id_idx
  on admin_groups (org_id, external_id)
  where external_id is not null;
