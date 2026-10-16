-- Enrollment authority is explicitly issued to a trusted installation.
-- Ordinary bot account requests cannot include this scope.
insert into iam_permission_catalog (permission, catalog_version) values
  ('agent.accounts.request', 2)
on conflict (permission) do nothing;
