-- Reconcile main's HTTP permissions with the tenant IAM catalog. Existing roles
-- receive no additional authority; these permissions must be granted explicitly.
insert into iam_permission_catalog (permission, catalog_version) values
  ('admin.backups.restore', 2),
  ('admin.chat', 2),
  ('admin.drive', 2)
on conflict (permission) do nothing;
